mod activity;
mod assistant;
mod commands;
mod connection;
mod connections_io;
mod error;
mod export;
mod logging;
mod models;
mod object_commands;
mod paths;
mod pg;
mod saved_scripts;
mod secrets;
mod sidebar_layout;
mod ssh_tunnel;
mod state;

use tauri::Manager;

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
        object_commands::list_extensions,
        object_commands::list_available_extensions,
        object_commands::extension_action,
        object_commands::server_activity,
        object_commands::server_locks,
        object_commands::signal_backend,
        object_commands::list_roles,
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
