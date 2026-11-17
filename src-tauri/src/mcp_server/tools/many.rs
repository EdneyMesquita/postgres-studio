//! run_script_on_connections: one script on several connections (each
//! with its database), one after the other, approved once for all of
//! them.

use std::time::Instant;

use serde_json::Value;

use super::{
    bool_arg, check_script, invalid, run_script, script_timeout, sql_arg, Call, ScriptMode,
    ToolOutput, MAX_CODE,
};
use crate::assistant::{plural, truncate};
use crate::error::{AppError, AppResult};
use crate::logging;
use crate::mcp_server::policy::{self, Answer, Cap, Decision, Request};
use crate::mcp_server::tasks::Phase;
use crate::mcp_server::Level;
use crate::models::{ConnectionProfile, Environment};

/// Targets per call.
pub(super) const MAX_TARGETS: usize = 20;

/// A connection and the database to run on there.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Target {
    connection_id: String,
    database: String,
}

/// The `targets` argument, also when sent as a JSON string; duplicates
/// are dropped.
fn targets(args: &Value) -> AppResult<Vec<Target>> {
    let parsed;
    let list = match args.get("targets") {
        Some(Value::Array(list)) => list,
        Some(Value::String(text)) => {
            parsed = serde_json::from_str::<Value>(text)
                .map_err(|_| invalid("targets must be an array of { connection_id, database }."))?;
            parsed.as_array().ok_or_else(|| {
                invalid("targets must be an array of { connection_id, database }.")
            })?
        }
        _ => {
            return Err(invalid(
                "targets is required: an array of { connection_id, database }, ids from \
                 list_connections.",
            ))
        }
    };
    let field = |item: &Value, key: &str| {
        item.get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string)
    };
    let mut out: Vec<Target> = Vec::new();
    for item in list {
        let (Some(connection_id), Some(database)) =
            (field(item, "connection_id"), field(item, "database"))
        else {
            return Err(invalid(
                "Each target needs a connection_id (from list_connections) and a database.",
            ));
        };
        let target = Target {
            connection_id,
            database,
        };
        if !out.contains(&target) {
            out.push(target);
        }
    }
    if out.is_empty() {
        return Err(invalid("targets is empty."));
    }
    if out.len() > MAX_TARGETS {
        return Err(invalid(format!("At most {MAX_TARGETS} targets per call.")));
    }
    Ok(out)
}

pub(super) async fn run(call: &mut Call<'_>, args: &Value) -> ToolOutput {
    let targets = match targets(args) {
        Ok(targets) => targets,
        Err(e) => return call.fail(e),
    };
    let checked = sql_arg(args).and_then(|sql| {
        let mode = ScriptMode::of(args)?;
        check_script(&sql, mode)?;
        Ok((sql, mode))
    });
    let (sql, mode) = match checked {
        Ok(checked) => checked,
        Err(e) => return call.fail(e),
    };
    let n = targets.len();
    call.target.detail = Some(plural(n as u64, "target", "targets"));

    let config = call.inner.config();
    let (cap, need) = match mode {
        ScriptMode::ReadOnly => (Cap::Read, Level::Read),
        _ => (Cap::Script, Level::Write),
    };
    let decisions: Vec<Decision> = targets
        .iter()
        .map(|t| policy::decide(&config, cap, Some(&t.connection_id), need))
        .collect();
    if decisions.contains(&Decision::Off) {
        return call.refuse("Refused: turned off", policy::REFUSED_OFF);
    }
    let store = &call.inner.state().connection_store;
    let mut profiles: Vec<ConnectionProfile> = Vec::with_capacity(n);
    for t in &targets {
        match store.get(&t.connection_id) {
            Ok(profile) => profiles.push(profile),
            Err(_) => {
                return call.fail(AppError::NotFound(format!(
                    "no saved connection has the id {}; call list_connections",
                    t.connection_id
                )))
            }
        }
    }
    let mut refused: Vec<String> = profiles
        .iter()
        .zip(&decisions)
        .filter(|(_, d)| **d == Decision::NoAccess)
        .map(|(p, _)| p.name.clone())
        .collect();
    refused.dedup();
    if !refused.is_empty() {
        let mut text = format!(
            "Nothing ran. On {}: {}",
            refused.join(", "),
            policy::REFUSED_NO_ACCESS
        );
        if mode == ScriptMode::Normal {
            text.push_str(" A script that only reads can run there with read_only: true.");
        }
        return call.refuse("Refused: no access", &text);
    }

    let places: Vec<String> = targets
        .iter()
        .zip(&profiles)
        .map(|(t, p)| format!("{} ({})", p.name, t.database))
        .collect();
    let mut ids: Vec<String> = targets.iter().map(|t| t.connection_id.clone()).collect();
    ids.dedup();
    let mut environments: Vec<&str> = profiles
        .iter()
        .filter_map(|p| p.environment.map(Environment::id))
        .collect();
    environments.sort_unstable();
    environments.dedup();
    call.target.names = Some(places.join(", "));
    call.target.ids = ids.clone();
    call.target.environments = (!environments.is_empty()).then(|| environments.join(", "));
    call.code = Some(sql.clone());
    // On production, every change is asked about; a dry run too.
    let guarded = config.confirm_production
        && cap == Cap::Script
        && profiles
            .iter()
            .any(|p| p.environment == Some(Environment::Production));
    let label = if guarded || decisions.contains(&Decision::Ask) {
        call.task.set_phase(Phase::Approval);
        let verb = match mode {
            ScriptMode::Normal => "Run a script",
            ScriptMode::ReadOnly => "Run a read-only script",
            ScriptMode::DryRun => "Dry-run a script (rolled back)",
        };
        let request = Request {
            tool: "run_script_on_connections",
            capability: cap,
            connection_id: None,
            connection_name: Some(places.join(", ")),
            database: None,
            title: format!("{verb} ({})", plural(n as u64, "target", "targets")),
            code: truncate(sql.clone(), MAX_CODE),
            dry_run: None,
            connection_ids: ids,
            production: guarded,
        };
        match policy::ask(call.inner, call.client, &request).await {
            Answer::Once => "Approved by you",
            Answer::Always => "Approved by you (always)",
            Answer::Deny => return call.refuse("Denied by you", policy::DENIED),
            Answer::Timeout => return call.refuse("Not answered", policy::NOT_ANSWERED),
            Answer::Closed => return call.refuse("Closed", policy::CLOSED),
        }
    } else if decisions.iter().all(|d| *d == Decision::AllowAlways) {
        "Allowed (always)"
    } else {
        "Allowed"
    };
    call.start_running(label);

    let stop_on_error = bool_arg(args, "stop_on_error");
    let timeout = script_timeout(args);
    let mut sections = Vec::with_capacity(n);
    let (mut ok, mut failed) = (0usize, 0usize);
    let mut stopped = false;
    for ((target, profile), place) in targets.iter().zip(&profiles).zip(&places) {
        let heading = format!("## {place} [{}]", profile.id);
        if stopped {
            sections.push(format!(
                "{heading}\nNot run: stopped after a failure (stop_on_error)."
            ));
            continue;
        }
        call.task.print(format!("## {place}"));
        let started = Instant::now();
        let session = match call
            .inner
            .pool
            .session(call.inner.host.as_ref(), profile)
            .await
        {
            Ok(session) => session,
            Err(e) => {
                failed += 1;
                stopped = stop_on_error;
                sections.push(format!("{heading}\nFailed to connect: {}", message(&e)));
                forget_if_lost(call, profile, &e).await;
                continue;
            }
        };
        let outcome = run_script(&session, &target.database, &sql, timeout, mode, &call.task).await;
        let took = started.elapsed().as_millis();
        match outcome {
            Ok(done) => {
                ok += 1;
                sections.push(format!("{heading} - {took} ms\n{}", done.text));
            }
            Err(e) => {
                failed += 1;
                stopped = stop_on_error;
                sections.push(format!("{heading} - {took} ms\nFailed: {}", message(&e)));
                forget_if_lost(call, profile, &e).await;
            }
        }
    }

    let mut summary = format!(
        "Ran the script{} on {ok} of {}",
        match mode {
            ScriptMode::Normal => "",
            ScriptMode::ReadOnly => " (read-only)",
            ScriptMode::DryRun => " as a dry run (rolled back everywhere)",
        },
        plural(n as u64, "target", "targets")
    );
    if failed > 0 {
        summary.push_str(&format!("; it failed on {failed}"));
    }
    summary.push('.');
    let text = format!("{summary}\n\n{}", sections.join("\n\n"));
    let meta = format!("{ok}/{n} ok");
    let label = if failed > 0 {
        format!("{label} · {failed} failed")
    } else {
        label.to_string()
    };
    call.log(&label);
    let result = if ok == 0 { "err" } else { "ok" };
    call.finish(result, label, meta, text)
}

fn message(error: &AppError) -> String {
    let text = logging::scrub_credentials(&error.to_string());
    if super::lost_connection(error) {
        format!("{text} - the connection was lost: check the VPN or the network.")
    } else {
        text
    }
}

/// A lost connection is closed, so the next call reconnects.
async fn forget_if_lost(call: &Call<'_>, profile: &ConnectionProfile, error: &AppError) {
    if super::lost_connection(error) {
        call.inner
            .pool
            .close(&profile.id, "the connection was lost")
            .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn targets_are_checked_and_deduplicated() {
        let a = json!({ "connection_id": "a", "database": "shop" });
        let b = json!({ "connection_id": "a", "database": "shop_eu" });
        let got = targets(&json!({ "targets": [a, b, a] })).unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[1].database, "shop_eu");
        let text = json!({ "targets": "[{\"connection_id\":\"a\",\"database\":\"x\"}]" });
        assert_eq!(targets(&text).unwrap().len(), 1);
        assert!(targets(&json!({ "targets": [] })).is_err());
        assert!(targets(&json!({ "targets": [{ "connection_id": "a" }] })).is_err());
        assert!(targets(&json!({})).is_err());
        let many: Vec<Value> = (0..21)
            .map(|i| json!({ "connection_id": i.to_string(), "database": "x" }))
            .collect();
        assert!(targets(&json!({ "targets": many })).is_err());
    }
}
