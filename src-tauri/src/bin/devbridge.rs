//! Serves the app's commands over HTTP for driving the UI from a browser
//! during development. See `postgres_studio_lib::devbridge`.

fn main() {
    postgres_studio_lib::devbridge::run();
}
