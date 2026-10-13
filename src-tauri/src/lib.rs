mod activity;
mod assistant;
mod commands;
mod connection;
mod connections_io;
mod csv_import;
mod dump;
mod error;
mod export;
mod logging;
mod models;
mod object_commands;
mod paths;
mod pg;
mod saved_scripts;
mod script_file;
mod secrets;
mod sidebar_layout;
mod ssh_tunnel;
mod state;
mod timescale_commands;
mod window_size;

use tauri::Manager;
use tauri_plugin_window_state::StateFlags;

use assistant::Assistant;
use saved_scripts::SavedScriptsStore;
use sidebar_layout::SidebarLayoutStore;
use state::AppState;

#[cfg(feature = "devbridge")]
pub mod devbridge;

/// The commands the frontend can call.
fn with_commands<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.invoke_handler(tauri::generate_handler![
        commands::list_connection_profiles,
        commands::get_connection_profile,
        commands::save_connection_profile,
        commands::delete_connection_profile,
        commands::test_connection,
        commands::connect,
        commands::disconnect,
        commands::secret_backend_info,
        commands::list_databases,
        commands::list_schemas,
        commands::list_schema_objects,
        commands::describe_table,
        commands::schema_diagram,
        commands::save_svg,
        commands::object_definition,
        commands::browse_table,
        commands::count_rows,
        commands::run_sql,
        commands::release_tab,
        commands::tab_transaction,
        commands::apply_edits,
        commands::explain_sql,
        commands::cancel_query,
        commands::export_query,
        commands::export_rows,
        commands::export_connections,
        commands::import_connections,
        commands::preview_connections_import,
        commands::get_sidebar_layout,
        commands::save_sidebar_layout,
        commands::suggest_script_path,
        commands::save_script,
        commands::list_saved_scripts,
        commands::read_saved_script,
        commands::assistant_detect,
        commands::assistant_set_policy,
        commands::assistant_start,
        commands::assistant_send,
        commands::assistant_stop,
        commands::assistant_close,
        commands::assistant_answer,
        commands::assistant_workdir,
        commands::open_log_dir,
        window_size::remember_window_size,
        dump::pg_tools_info,
        dump::backup_format,
        dump::dump_database,
        dump::restore_database,
        commands::graph_catalog,
        commands::graph_label_properties,
        object_commands::list_extensions,
        object_commands::list_available_extensions,
        object_commands::extension_action,
        object_commands::server_activity,
        object_commands::server_locks,
        object_commands::signal_backend,
        object_commands::list_roles,
        object_commands::run_maintenance,
        timescale_commands::timescale_info,
        timescale_commands::timescale_hypertable,
        timescale_commands::timescale_cagg,
        timescale_commands::timescale_jobs,
        timescale_commands::timescale_drop_chunks_preview,
        timescale_commands::timescale_action_sql,
        timescale_commands::timescale_action,
        script_file::run_sql_file,
        script_file::sql_file_info,
        csv_import::preview_csv,
        csv_import::import_csv,
    ])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // First, while this is still the only thread.
    logging::init_local_offset();
    logging::install_panic_hook();

    with_commands(tauri::Builder::default())
        // First, so what the other plugins log is caught too.
        .plugin(logging::plugin())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Size, position and maximized state come back from the last run.
        // Not visibility: the window starts hidden and the page shows it once
        // it has painted, so it never opens on a blank white frame.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(window_state_flags())
                .build(),
        )
        .setup(|app| {
            logging::log_startup(app);
            setup(app).inspect_err(|e| log::error!("startup failed: {e}"))
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_, event| {
            // Tells a clean quit apart from a crash, which ends the log
            // without this line.
            if let tauri::RunEvent::Exit = event {
                log::info!("Postgres Studio exiting");
            }
        });
}

fn setup<R: tauri::Runtime>(app: &mut tauri::App<R>) -> Result<(), Box<dyn std::error::Error>> {
    let config_dir = app.path().app_config_dir()?;
    if let Some(window) = app.get_webview_window("main") {
        window_size::restore(&window, &config_dir);
    }
    // The page shows the window as soon as it paints. Should it never get
    // there (a broken bundle, a hung webview), show it anyway.
    if let Some(window) = app.get_webview_window("main") {
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(4));
            if !window.is_visible().unwrap_or(true) {
                log::warn!("the page didn't show the window in time; showing it");
                let _ = window.show();
            }
        });
    }
    // Saved on close by the plugin, and also once a move or resize settles,
    // so a crash or a killed process doesn't lose the window's last place.
    if let Some(window) = app.get_webview_window("main") {
        use std::sync::atomic::{AtomicU64, Ordering};
        use tauri_plugin_window_state::AppHandleExt;
        let handle = app.handle().clone();
        let latest = std::sync::Arc::new(AtomicU64::new(0));
        window.on_window_event(move |event| {
            if matches!(
                event,
                tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)
            ) {
                let mine = latest.fetch_add(1, Ordering::SeqCst) + 1;
                let latest = latest.clone();
                let handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
                    if latest.load(Ordering::SeqCst) == mine {
                        if let Err(e) = handle.save_window_state(window_state_flags()) {
                            log::warn!("couldn't save the window's place: {e}");
                        }
                    }
                });
            }
        });
    }
    let state =
        AppState::init(&config_dir).map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
    app.manage(state);
    let scripts = SavedScriptsStore::load(&config_dir, &app.path().home_dir()?)
        .map_err(|e| -> Box<dyn std::error::Error> { e.to_string().into() })?;
    app.manage(scripts);
    let layout = SidebarLayoutStore::load(&config_dir)
        .map_err(|e| -> Box<dyn std::error::Error> { e.to_string().into() })?;
    app.manage(layout);
    // The agents run in an empty folder of the app's own, so they see none
    // of the user's files - one they can see at all, see `paths`.
    let workdir = paths::shared_dir(app.path().app_data_dir()?.join("assistant"), "assistant");
    app.manage(Assistant::new(
        std::sync::Arc::new(app.handle().clone()),
        workdir,
    ));
    Ok(())
}

/// What the plugin keeps between runs: not visibility (the window starts
/// hidden and the page shows it) and not the size (window_size.rs).
fn window_state_flags() -> StateFlags {
    StateFlags::all() - StateFlags::VISIBLE - StateFlags::SIZE
}
