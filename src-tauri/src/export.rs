//! Writing results to CSV or JSON: rows already on screen, or a whole
//! query streamed from the server.
//!
//! Values are the server's text form. In JSON, numbers, booleans and
//! json/jsonb keep their own JSON shape; everything else is a string, and
//! NULL is null. In CSV, NULL is an empty cell.

use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures_util::{pin_mut, TryStreamExt};
use tokio_postgres::SimpleQueryMessage;

use crate::error::{AppError, AppResult};
use crate::models::{ExportFormat, ExportSummary};
use crate::pg::run::ResultColumn;
use crate::pg::{split, PgClient};

const PROGRESS_EVERY: u64 = 500;

/// What a column's values look like in JSON.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum JsonKind {
    Number,
    Bool,
    Json,
    Text,
}

fn json_kind(column: &ResultColumn) -> JsonKind {
    match column.type_oid {
        20 | 21 | 23 | 26 | 700 | 701 | 1700 => JsonKind::Number,
        16 => JsonKind::Bool,
        114 | 3802 => JsonKind::Json,
        _ => JsonKind::Text,
    }
}

fn json_value(kind: JsonKind, value: Option<&str>) -> String {
    let Some(v) = value else {
        return "null".to_string();
    };
    let looks_numeric = |s: &str| {
        let s = s.strip_prefix('-').unwrap_or(s);
        !s.is_empty()
            && s.chars().next().is_some_and(|c| c.is_ascii_digit())
            && s.chars()
                .all(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-'))
            && serde_json::from_str::<serde_json::Number>(v).is_ok()
    };
    match kind {
        JsonKind::Number if looks_numeric(v) => v.to_string(),
        JsonKind::Bool => (if v == "t" { "true" } else { "false" }).to_string(),
        JsonKind::Json if serde_json::from_str::<serde_json::Value>(v).is_ok() => v.to_string(),
        _ => serde_json::to_string(v).unwrap_or_default(),
    }
}

/// Writes rows one at a time, so a streamed export holds one row in memory.
enum Writer {
    Csv(Box<csv::Writer<std::fs::File>>),
    Json {
        out: std::io::BufWriter<std::fs::File>,
        names: Vec<String>,
        kinds: Vec<JsonKind>,
        first: bool,
    },
}

impl Writer {
    fn open(path: &Path, format: ExportFormat, columns: &[ResultColumn]) -> AppResult<Self> {
        let file = std::fs::File::create(path)?;
        Ok(match format {
            ExportFormat::Csv => {
                let mut csv = csv::Writer::from_writer(file);
                csv.write_record(columns.iter().map(|c| c.name.as_str()))
                    .map_err(csv_err)?;
                Writer::Csv(Box::new(csv))
            }
            ExportFormat::Json => {
                let mut out = std::io::BufWriter::new(file);
                out.write_all(b"[")?;
                Writer::Json {
                    out,
                    names: columns
                        .iter()
                        .map(|c| serde_json::to_string(&c.name).unwrap_or_default())
                        .collect(),
                    kinds: columns.iter().map(json_kind).collect(),
                    first: true,
                }
            }
        })
    }

    fn row<'a>(&mut self, values: impl Iterator<Item = Option<&'a str>>) -> AppResult<()> {
        match self {
            Writer::Csv(csv) => csv
                .write_record(values.map(|v| v.unwrap_or("")))
                .map_err(csv_err),
            Writer::Json {
                out,
                names,
                kinds,
                first,
            } => {
                let fields: Vec<String> = values
                    .enumerate()
                    .map(|(i, v)| {
                        let kind = kinds.get(i).copied().unwrap_or(JsonKind::Text);
                        let name = names
                            .get(i)
                            .cloned()
                            .unwrap_or_else(|| format!("\"column{i}\""));
                        format!("{name}: {}", json_value(kind, v))
                    })
                    .collect();
                let sep = if *first { "\n  " } else { ",\n  " };
                *first = false;
                write!(out, "{sep}{{{}}}", fields.join(", "))?;
                Ok(())
            }
        }
    }

    fn finish(self) -> AppResult<()> {
        match self {
            Writer::Csv(mut csv) => csv.flush().map_err(AppError::Io),
            Writer::Json { mut out, first, .. } => {
                out.write_all(if first { b"]\n" } else { b"\n]\n" })?;
                out.flush()?;
                Ok(())
            }
        }
    }
}

/// Writes rows the frontend already holds, such as a console result.
pub fn export_rows(
    columns: &[ResultColumn],
    rows: &[Vec<Option<String>>],
    format: ExportFormat,
    path: &Path,
) -> AppResult<ExportSummary> {
    let mut writer = Writer::open(path, format, columns)?;
    for row in rows {
        writer.row(row.iter().map(|v| v.as_deref()))?;
    }
    writer.finish()?;
    Ok(ExportSummary {
        rows_written: rows.len() as u64,
        columns: columns.iter().map(|c| c.name.clone()).collect(),
    })
}

/// Streams every row of one query to `path`. `cancel` stops it between
/// rows; the file keeps what was written so far.
pub async fn export_query(
    client: &PgClient,
    sql: &str,
    format: ExportFormat,
    path: &Path,
    pooler_mode: bool,
    cancel: Arc<AtomicBool>,
    on_progress: impl Fn(u64),
) -> AppResult<ExportSummary> {
    let statements = split::split(sql);
    let [stmt] = statements.as_slice() else {
        return Err(AppError::InvalidInput(
            "Export takes exactly one query.".to_string(),
        ));
    };
    let mut columns: Vec<ResultColumn> = Vec::new();
    if !pooler_mode {
        let prepared = client.client.prepare(&stmt.text).await?;
        if prepared.columns().is_empty() {
            return Err(AppError::InvalidInput(
                "That statement returns no rows to export.".to_string(),
            ));
        }
        columns = prepared
            .columns()
            .iter()
            .map(|c| ResultColumn {
                name: c.name().to_string(),
                type_name: c.type_().name().to_string(),
                type_oid: c.type_().oid(),
            })
            .collect();
    }
    let stream = client.client.simple_query_raw(&stmt.text).await?;
    pin_mut!(stream);
    let mut writer: Option<Writer> = None;
    let mut written = 0u64;
    while let Some(message) = stream.try_next().await? {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        match message {
            SimpleQueryMessage::RowDescription(cols) if columns.is_empty() => {
                columns = cols
                    .iter()
                    .map(|c| ResultColumn {
                        name: c.name().to_string(),
                        type_name: "unknown".to_string(),
                        type_oid: 0,
                    })
                    .collect();
            }
            SimpleQueryMessage::Row(row) => {
                if writer.is_none() {
                    writer = Some(Writer::open(path, format, &columns)?);
                }
                if let Some(w) = writer.as_mut() {
                    w.row((0..row.len()).map(|i| row.get(i)))?;
                }
                written += 1;
                if written.is_multiple_of(PROGRESS_EVERY) {
                    on_progress(written);
                }
            }
            _ => {}
        }
    }
    let writer = match writer {
        Some(w) => w,
        None => Writer::open(path, format, &columns)?,
    };
    writer.finish()?;
    on_progress(written);
    if cancel.load(Ordering::Relaxed) {
        return Err(AppError::Cancelled);
    }
    Ok(ExportSummary {
        rows_written: written,
        columns: columns.into_iter().map(|c| c.name).collect(),
    })
}

fn csv_err(e: csv::Error) -> AppError {
    AppError::Io(std::io::Error::other(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, oid: u32) -> ResultColumn {
        ResultColumn {
            name: name.to_string(),
            type_name: String::new(),
            type_oid: oid,
        }
    }

    fn temp(ext: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "postgres-studio-export-{}.{ext}",
            uuid::Uuid::new_v4()
        ))
    }

    fn rows() -> Vec<Vec<Option<String>>> {
        vec![
            vec![
                Some("1".into()),
                Some("t".into()),
                Some("{\"a\": [1]}".into()),
                Some("say \"hi\", ok".into()),
                Some("12.50".into()),
            ],
            vec![Some("2".into()), None, None, None, Some("NaN".into())],
        ]
    }

    fn columns() -> Vec<ResultColumn> {
        vec![
            col("id", 20),
            col("ok", 16),
            col("meta", 3802),
            col("note", 25),
            col("price", 1700),
        ]
    }

    #[test]
    fn csv_has_a_header_and_empty_nulls() {
        let path = temp("csv");
        let summary = export_rows(&columns(), &rows(), ExportFormat::Csv, &path).unwrap();
        assert_eq!(summary.rows_written, 2);
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            text,
            "id,ok,meta,note,price\n1,t,\"{\"\"a\"\": [1]}\",\"say \"\"hi\"\", ok\",12.50\n2,,,,NaN\n"
        );
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn json_keeps_types_and_stays_valid() {
        let path = temp("json");
        export_rows(&columns(), &rows(), ExportFormat::Json, &path).unwrap();
        let parsed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(parsed[0]["id"], 1);
        assert_eq!(parsed[0]["ok"], true);
        assert_eq!(parsed[0]["meta"]["a"][0], 1);
        assert_eq!(parsed[0]["note"], "say \"hi\", ok");
        // numeric digits are written as the server gave them
        assert!(std::fs::read_to_string(&path)
            .unwrap()
            .contains("\"price\": 12.50"));
        assert!(parsed[1]["ok"].is_null());
        // NaN isn't JSON, so it stays a string
        assert_eq!(parsed[1]["price"], "NaN");
        std::fs::remove_file(path).ok();

        let empty = temp("json");
        export_rows(&columns(), &[], ExportFormat::Json, &empty).unwrap();
        let parsed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&empty).unwrap()).unwrap();
        assert_eq!(parsed, serde_json::json!([]));
        std::fs::remove_file(empty).ok();
    }
}
