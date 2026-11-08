use anyhow::{Context, Result, bail};
use std::{env, fs, path::Path};
use workspace_openapi::View;

fn main() -> Result<()> {
    let args: Vec<_> = env::args().skip(1).collect();
    match args.as_slice() {
        [show, view] if show == "show" => print!("{}", view.parse::<View>()?.rendered()),
        [mode] if mode == "export" || mode == "check" => {
            for view in View::ALL {
                let path = Path::new(view.path());
                let text = view.rendered();
                if mode == "check" {
                    let current =
                        fs::read(path).with_context(|| format!("Read {}", path.display()))?;
                    if current != text.as_bytes() {
                        bail!(
                            "{} differs from the Rust backend. Run cargo run -p workspace-openapi -- export.",
                            path.display()
                        );
                    }
                } else {
                    fs::write(path, text).with_context(|| format!("Write {}", path.display()))?;
                }
            }
        }
        _ => bail!("From the repository root, use workspace-openapi export, check or show <view>."),
    }
    Ok(())
}
