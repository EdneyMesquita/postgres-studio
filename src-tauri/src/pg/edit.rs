//! Applying the grid's pending changes: updates, inserts and deletes on one
//! table, all in one transaction.
//!
//! Rows are found by their key (primary key, or a unique key over NOT NULL
//! columns). Every change must touch exactly one row; if one finds none -
//! the row was changed or deleted meanwhile - everything rolls back.
//! Values travel as text parameters cast to each column's type, so nothing
//! the user typed is ever spliced into the SQL.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tokio_postgres::types::{ToSql, Type};

use super::{ident, qualified, run::relation_columns, PgClient};
use crate::error::{AppError, AppResult};

/// A column's value: text as Postgres would print it, or NULL.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellValue {
    pub column: String,
    pub value: Option<String>,
    /// On insert: leave the column to its DEFAULT instead.
    #[serde(default)]
    pub use_default: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RowEdit {
    Update {
        key: Vec<CellValue>,
        values: Vec<CellValue>,
    },
    Insert {
        values: Vec<CellValue>,
    },
    Delete {
        key: Vec<CellValue>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    /// Per edit, the row as stored afterwards (none for deletes), in the
    /// table's column order.
    pub rows: Vec<Option<Vec<Option<String>>>>,
}

pub async fn apply(
    client: &PgClient,
    schema: &str,
    table: &str,
    edits: &[RowEdit],
) -> AppResult<ApplyResult> {
    if edits.is_empty() {
        return Ok(ApplyResult { rows: vec![] });
    }
    let columns = relation_columns(client, schema, table).await?;
    if columns.is_empty() {
        return Err(AppError::NotFound(format!("table {schema}.{table}")));
    }
    let types: HashMap<&str, &str> = columns
        .iter()
        .map(|c| (c.name.as_str(), c.type_name.as_str()))
        .collect();
    let returning = columns
        .iter()
        .map(|c| format!("{}::text", ident(&c.name)))
        .collect::<Vec<_>>()
        .join(", ");
    let target = qualified(schema, table);

    client.client.batch_execute("BEGIN").await?;
    let mut rows = Vec::with_capacity(edits.len());
    for (n, edit) in edits.iter().enumerate() {
        match apply_one(client, &target, &types, &returning, edit).await {
            Ok(row) => rows.push(row),
            Err(e) => {
                let _ = client.client.batch_execute("ROLLBACK").await;
                return Err(match e {
                    AppError::Database(mut db) => {
                        db.message = format!("Change {} of {}: {}", n + 1, edits.len(), db.message);
                        AppError::Database(db)
                    }
                    other => other,
                });
            }
        }
    }
    if let Err(e) = client.client.batch_execute("COMMIT").await {
        let _ = client.client.batch_execute("ROLLBACK").await;
        return Err(e.into());
    }
    Ok(ApplyResult { rows })
}

async fn apply_one(
    client: &PgClient,
    target: &str,
    types: &HashMap<&str, &str>,
    returning: &str,
    edit: &RowEdit,
) -> AppResult<Option<Vec<Option<String>>>> {
    let type_of = |column: &str| {
        types
            .get(column)
            .copied()
            .ok_or_else(|| AppError::InvalidInput(format!("no column {column} in {target}")))
    };
    let mut params: Vec<Option<String>> = Vec::new();
    let mut param = |value: &Option<String>, column: &str| -> AppResult<String> {
        params.push(value.clone());
        Ok(format!("${}::{}", params.len(), type_of(column)?))
    };
    let where_of = |key: &[CellValue],
                    param: &mut dyn FnMut(&Option<String>, &str) -> AppResult<String>|
     -> AppResult<String> {
        if key.is_empty() {
            return Err(AppError::InvalidInput(
                "This table has no primary or unique key, so its rows can't be told apart for editing."
                    .to_string(),
            ));
        }
        let parts = key
            .iter()
            .map(|k| {
                let placeholder = param(&k.value, &k.column)?;
                // A key column is NOT NULL, but say so rather than compare to NULL.
                Ok(match k.value {
                    Some(_) => format!("{} = {placeholder}", ident(&k.column)),
                    None => format!("{} IS NULL", ident(&k.column)),
                })
            })
            .collect::<AppResult<Vec<_>>>()?;
        Ok(parts.join(" AND "))
    };

    let (sql, expect_row) = match edit {
        RowEdit::Update { key, values } => {
            if values.is_empty() {
                return Ok(None);
            }
            let sets = values
                .iter()
                .map(|v| {
                    Ok(format!(
                        "{} = {}",
                        ident(&v.column),
                        param(&v.value, &v.column)?
                    ))
                })
                .collect::<AppResult<Vec<_>>>()?
                .join(", ");
            let cond = where_of(key, &mut param)?;
            (
                format!("UPDATE {target} SET {sets} WHERE {cond} RETURNING {returning}"),
                true,
            )
        }
        RowEdit::Insert { values } => {
            let given: Vec<&CellValue> = values.iter().filter(|v| !v.use_default).collect();
            if given.is_empty() {
                (
                    format!("INSERT INTO {target} DEFAULT VALUES RETURNING {returning}"),
                    true,
                )
            } else {
                let cols = given
                    .iter()
                    .map(|v| ident(&v.column))
                    .collect::<Vec<_>>()
                    .join(", ");
                let vals = given
                    .iter()
                    .map(|v| param(&v.value, &v.column))
                    .collect::<AppResult<Vec<_>>>()?
                    .join(", ");
                (
                    format!("INSERT INTO {target} ({cols}) VALUES ({vals}) RETURNING {returning}"),
                    true,
                )
            }
        }
        RowEdit::Delete { key } => {
            let cond = where_of(key, &mut param)?;
            (
                format!("DELETE FROM {target} WHERE {cond} RETURNING 1"),
                false,
            )
        }
    };

    let typed: Vec<(&(dyn ToSql + Sync), Type)> = params
        .iter()
        .map(|p| (p as &(dyn ToSql + Sync), Type::TEXT))
        .collect();
    let found = client.client.query_typed(&sql, &typed).await?;
    match found.len() {
        1 => {}
        0 => {
            return Err(AppError::InvalidInput(
                "A row being changed no longer matches its key (it was changed or deleted \
                 meanwhile). Nothing was saved; refresh and try again."
                    .to_string(),
            ))
        }
        n => {
            return Err(AppError::InvalidInput(format!(
                "A change matched {n} rows instead of one. Nothing was saved."
            )))
        }
    }
    if !expect_row {
        return Ok(None);
    }
    let row = &found[0];
    Ok(Some(
        (0..row.len())
            .map(|i| row.get::<_, Option<String>>(i))
            .collect(),
    ))
}
