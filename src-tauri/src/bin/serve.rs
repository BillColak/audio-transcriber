//! Standalone backend for browser development: `cargo run --bin serve` gives the same API the
//! desktop app serves in-process, so `npm run dev` keeps working now that Node is gone.
#[tokio::main]
async fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    if let Err(error) = app_lib::serve(None).await {
        eprintln!("backend stopped: {error}");
        std::process::exit(1);
    }
}
