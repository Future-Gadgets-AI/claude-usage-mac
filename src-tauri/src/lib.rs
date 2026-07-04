use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;

use serde_json::Value;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WindowEvent,
};
use tauri_plugin_positioner::{Position, WindowExt};

// Kept in sync with bin/claude-usage (shell CLI) — update both together.
const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const STATUS_URL: &str = "https://status.claude.com/api/v2/summary.json";
const KEYCHAIN_SERVICE: &str = "Claude Code-credentials";

// Claude Code's own User-Agent. The usage endpoint serves non-Claude-Code
// clients from an aggressive rate-limit bucket (persistent 429s) unless this
// header matches, so it is required, not cosmetic.
const USER_AGENT: &str = "claude-code/2.1.71";

/// Read the Claude Code OAuth credentials blob from the macOS Keychain.
/// On Linux the upstream extension reads ~/.claude/.credentials.json; on macOS
/// Claude Code stores the same JSON as a generic-password Keychain item.
fn read_credentials_blob() -> Result<String, String> {
    let output = Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"])
        .output()
        .map_err(|e| format!("keychain-exec-failed: {e}"))?;

    if !output.status.success() {
        return Err("no-credentials".into());
    }

    String::from_utf8(output.stdout)
        .map(|s| s.trim().to_string())
        .map_err(|e| format!("keychain-decode-failed: {e}"))
}

fn extract_access_token(blob: &str) -> Result<String, String> {
    let v: Value =
        serde_json::from_str(blob).map_err(|_| "credentials-parse-failed".to_string())?;
    v.get("claudeAiOauth")
        .and_then(|o| o.get("accessToken"))
        .and_then(|t| t.as_str())
        .map(str::to_string)
        .ok_or_else(|| "no-token".to_string())
}

/// Fetch live usage. Deliberately read-only: on a 401 we surface `reauth-needed`
/// rather than performing the refresh-token dance the GNOME version does. On
/// macOS that token lives in a Keychain item Claude Code owns; refreshing and
/// writing it back risks invalidating the user's real session, so we let Claude
/// Code own the token lifecycle and just ask the user to reopen it.
#[tauri::command]
async fn get_usage() -> Result<String, String> {
    let blob = read_credentials_blob()?;
    let token = extract_access_token(&blob)?;

    let resp = reqwest::Client::new()
        .get(USAGE_URL)
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .map_err(|e| format!("request-failed: {e}"))?;

    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("reauth-needed".into());
    }
    if !status.is_success() {
        return Err(format!("http-{}", status.as_u16()));
    }

    resp.text().await.map_err(|e| format!("read-failed: {e}"))
}

/// Expose only the non-secret account metadata from the credentials blob
/// (plan, rate-limit tier, expiry). The access/refresh tokens never leave Rust.
#[tauri::command]
fn get_credentials_meta() -> Result<Value, String> {
    let blob = read_credentials_blob()?;
    let v: Value =
        serde_json::from_str(&blob).map_err(|_| "credentials-parse-failed".to_string())?;
    let oauth = v
        .get("claudeAiOauth")
        .ok_or_else(|| "no-oauth".to_string())?;
    Ok(serde_json::json!({
        "plan": oauth.get("subscriptionType"),
        "tier": oauth.get("rateLimitTier"),
        "expiresAt": oauth.get("expiresAt"),
    }))
}

#[tauri::command]
async fn get_status() -> Result<String, String> {
    let resp = reqwest::Client::new()
        .get(STATUS_URL)
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .map_err(|e| format!("request-failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("http-{}", resp.status().as_u16()));
    }

    resp.text().await.map_err(|e| format!("read-failed: {e}"))
}

fn log_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no-data-dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir-failed: {e}"))?;
    Ok(dir.join("history.jsonl"))
}

#[tauri::command]
fn append_log(app: AppHandle, line: String) -> Result<(), String> {
    let path = log_path(&app)?;
    let mut f = OpenOptions::new()
        .append(true)
        .create(true)
        .open(&path)
        .map_err(|e| format!("open-failed: {e}"))?;
    writeln!(f, "{}", line.trim_end()).map_err(|e| format!("write-failed: {e}"))
}

#[tauri::command]
fn read_log(app: AppHandle) -> Result<String, String> {
    let path = log_path(&app)?;
    match fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("read-failed: {e}")),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_positioner::init())
        .invoke_handler(tauri::generate_handler![
            get_usage,
            get_credentials_meta,
            get_status,
            append_log,
            read_log
        ])
        .on_window_event(|window, event| {
            // Dismiss the popover when it loses focus (click-away to close).
            if let WindowEvent::Focused(false) = event {
                let _ = window.hide();
            }
        })
        .setup(|app| {
            // Menu-bar app: no Dock icon.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let icon = app.default_window_icon().unwrap().clone();
            // Right-click menu: the only way to quit (there is no Dock icon).
            let quit = MenuItem::with_id(app, "quit", "Quit Claude Usage", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&quit])?;
            TrayIconBuilder::new()
                .icon(icon)
                .tooltip("Claude Usage")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    if event.id.as_ref() == "quit" {
                        app.exit(0);
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    tauri_plugin_positioner::on_tray_event(tray.app_handle(), &event);
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(win) = app.get_webview_window("main") {
                            if win.is_visible().unwrap_or(false) {
                                let _ = win.hide();
                            } else {
                                let _ = win.move_window(Position::TrayCenter);
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
