use std::{
    collections::HashMap,
    env, fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use chrono::Utc;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::{Emitter, Manager, State};
use term_dock_lib::{
    apply_workspace_update, bounded_tail, build_ai_context, build_remote_shell_command,
    claim_controller_attachment, controller_attachment_is_authorized, issue_remote_grant,
    mark_session_disconnected, mark_session_exited, mark_session_quiet, output_suggests_attention,
    parse_deep_link as parse_safe_deep_link, release_controller_attachment, remote_grant_summary,
    validate_ssh_target, validate_terminal_input, validate_terminal_size, validate_workspace,
    Activity, ActivityConfidence, AiContext, CreateRemoteGrant, CreateWorkspace, DeepLinkTarget,
    IssuedRemoteGrant, RemoteGrant, RemoteGrantSummary, Session, SessionAccess, SessionAttachment,
    SessionEvent, SessionEventHistory, SessionEventReplay, SessionState, TerminalSize, Workspace,
};
use uuid::Uuid;

const MAX_PREVIEW_CHARS: usize = 2_000;
const LIFECYCLE_POLL_INTERVAL: Duration = Duration::from_millis(250);
const OUTPUT_PERSIST_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Registry {
    workspaces: Vec<Workspace>,
    sessions: Vec<Session>,
    #[serde(default)]
    remote_grants: Vec<RemoteGrant>,
}

struct AppState {
    registry: Arc<Mutex<Registry>>,
    /// Keeping children in the native host makes a view closing harmless. The
    /// future terminal renderer attaches to this broker instead of owning PIDs.
    runtime: Arc<Mutex<HashMap<String, RuntimeSession>>>,
    /// A bounded, runtime-only recovery window for cursor-based stream resume.
    event_history: Arc<Mutex<HashMap<String, SessionEventHistory>>>,
    /// Serializes atomic registry writes from commands, monitors, and PTY
    /// reader threads so an older snapshot cannot replace a newer one.
    persistence_lock: Arc<Mutex<()>>,
    registry_path: PathBuf,
}

/// Owns everything required to persist and publish an authoritative lifecycle
/// change from either the foreground command path or a background monitor.
struct SessionStatePublisher {
    registry: Arc<Mutex<Registry>>,
    event_history: Arc<Mutex<HashMap<String, SessionEventHistory>>>,
    persistence_lock: Arc<Mutex<()>>,
    registry_path: PathBuf,
    app: tauri::AppHandle,
}

struct RuntimeSession {
    child: Box<dyn portable_pty::Child + Send>,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    /// One runtime-only, exclusive controller lease. Viewer attachments do
    /// not appear here and never gain PTY mutation authority.
    controller_attachment: Option<String>,
}

fn controller_runtime_session<'a>(
    runtime: &'a mut HashMap<String, RuntimeSession>,
    session_id: &str,
    attachment_id: &str,
) -> Result<&'a mut RuntimeSession, String> {
    let session = runtime
        .get_mut(session_id)
        .ok_or("session is not running on this local host")?;
    if !controller_attachment_is_authorized(&session.controller_attachment, attachment_id) {
        return Err("controller attachment is not authorized for this session".into());
    }
    Ok(session)
}

enum ChildObservation {
    Running,
    Exited(i32),
    Disconnected,
}

impl AppState {
    fn persist(&self) -> Result<(), String> {
        persist_registry(&self.registry, &self.registry_path, &self.persistence_lock)
    }
}

fn persist_registry(
    registry: &Mutex<Registry>,
    registry_path: &Path,
    persistence_lock: &Mutex<()>,
) -> Result<(), String> {
    let _write = persistence_lock
        .lock()
        .map_err(|_| "persistence lock failed")?;
    let registry = registry.lock().map_err(|_| "registry lock failed")?;
    let encoded = serde_json::to_vec_pretty(&*registry).map_err(|error| error.to_string())?;
    let temporary = registry_path.with_extension("tmp");
    fs::write(&temporary, encoded).map_err(|error| error.to_string())?;
    fs::rename(temporary, registry_path).map_err(|error| error.to_string())
}

fn publish_session_event(
    event_history: &Arc<Mutex<HashMap<String, SessionEventHistory>>>,
    app: &tauri::AppHandle,
    event: SessionEvent,
) -> Result<(), String> {
    let session_id = event.session_id().to_owned();
    event_history
        .lock()
        .map_err(|_| "event history lock failed")?
        .entry(session_id)
        .or_default()
        .push(event.clone());
    app.emit("session-event", event)
        .map_err(|error| format!("could not publish session event: {error}"))
}

impl SessionStatePublisher {
    fn publish(
        &self,
        session_id: &str,
        state: SessionState,
        exit_code: Option<i32>,
    ) -> Result<(), String> {
        let cursor = {
            let mut registry = self.registry.lock().map_err(|_| "registry lock failed")?;
            let session = registry
                .sessions
                .iter_mut()
                .find(|session| session.id == session_id)
                .ok_or("session not found")?;
            let changed = match state.clone() {
                SessionState::Quiet => mark_session_quiet(session, Utc::now()),
                SessionState::Disconnected => mark_session_disconnected(session, Utc::now()),
                SessionState::Exited => {
                    mark_session_exited(session, exit_code, Utc::now());
                    true
                }
                _ => false,
            };
            if !changed {
                return Ok(());
            }
            session.cursor
        };
        persist_registry(&self.registry, &self.registry_path, &self.persistence_lock)?;
        publish_session_event(
            &self.event_history,
            &self.app,
            SessionEvent::State {
                session_id: session_id.to_owned(),
                cursor,
                state,
            },
        )
    }
}

fn registry_path(app: &tauri::App) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("workspaces.json"))
}

fn load_state(app: &tauri::App) -> Result<AppState, String> {
    let registry_path = registry_path(app)?;
    let mut registry = if registry_path.exists() {
        serde_json::from_slice(&fs::read(&registry_path).map_err(|error| error.to_string())?)
            .map_err(|error| format!("workspace registry is invalid: {error}"))?
    } else {
        Registry::default()
    };
    let had_stale_sessions = registry
        .sessions
        .iter_mut()
        .any(|session| mark_session_disconnected(session, Utc::now()));
    let state = AppState {
        registry: Arc::new(Mutex::new(registry)),
        runtime: Arc::new(Mutex::new(HashMap::new())),
        event_history: Arc::new(Mutex::new(HashMap::new())),
        persistence_lock: Arc::new(Mutex::new(())),
        registry_path,
    };
    if had_stale_sessions {
        state.persist()?;
    }
    Ok(state)
}

fn ssh_executable() -> Option<PathBuf> {
    let names: &[&str] = if cfg!(target_os = "windows") {
        &["ssh.exe", "ssh"]
    } else {
        &["ssh"]
    };
    let path = env::var_os("PATH")?;
    env::split_paths(&path)
        .flat_map(|directory| names.iter().map(move |name| directory.join(name)))
        .find(|candidate| candidate.is_file())
}

fn validate_workspace_for_save(workspace: &CreateWorkspace) -> Result<(), String> {
    validate_workspace(workspace).map_err(|error| error.to_string())?;
    if workspace.ssh_target.is_some() {
        ssh_executable().ok_or("OpenSSH client was not found on this device")?;
        return Ok(());
    }
    if !PathBuf::from(&workspace.directory).is_dir() {
        return Err("workspace directory must exist locally before it can be launched".into());
    }
    if !PathBuf::from(&workspace.shell).is_file() {
        return Err("workspace shell must be an executable local path".into());
    }
    Ok(())
}

fn build_pty_command(workspace: &Workspace) -> Result<CommandBuilder, String> {
    if let Some(ssh_target) = &workspace.ssh_target {
        validate_ssh_target(ssh_target).map_err(|error| error.to_string())?;
        let executable = ssh_executable().ok_or("OpenSSH client was not found on this device")?;
        let remote_command = build_remote_shell_command(
            &workspace.directory,
            &workspace.shell,
            &workspace.startup_commands,
        );
        let mut command = CommandBuilder::new(executable);
        // `ssh_target` has a strict alias/user@host grammar, so it cannot be
        // mistaken for an SSH option. Credentials and transport policy remain
        // in the user's local SSH configuration and OS credential store.
        command.arg("-tt");
        command.arg(ssh_target);
        command.arg(remote_command);
        return Ok(command);
    }

    if !PathBuf::from(&workspace.directory).is_dir() {
        return Err("workspace directory must exist locally before it can be launched".into());
    }
    if !PathBuf::from(&workspace.shell).is_file() {
        return Err("workspace shell must be an executable local path".into());
    }
    let mut command = CommandBuilder::new(&workspace.shell);
    command.cwd(&workspace.directory);
    command.env("SHELL", &workspace.shell);
    if workspace.startup_commands.is_empty() {
        command.arg("-l");
    } else {
        command.args([
            "-lc",
            &format!(
                "{}\nexec \"$SHELL\" -l",
                workspace.startup_commands.join("\n")
            ),
        ]);
    }
    Ok(command)
}

#[tauri::command]
fn list_workspaces(state: State<'_, AppState>) -> Result<Vec<Workspace>, String> {
    Ok(state
        .registry
        .lock()
        .map_err(|_| "registry lock failed")?
        .workspaces
        .iter()
        .filter(|workspace| !workspace.archived)
        .cloned()
        .collect())
}

#[tauri::command]
fn list_sessions(state: State<'_, AppState>) -> Result<Vec<Session>, String> {
    Ok(state
        .registry
        .lock()
        .map_err(|_| "registry lock failed")?
        .sessions
        .clone())
}

#[tauri::command]
fn create_workspace(
    workspace: CreateWorkspace,
    state: State<'_, AppState>,
) -> Result<Workspace, String> {
    validate_workspace_for_save(&workspace)?;
    let now = Utc::now();
    let saved = Workspace {
        id: format!("ws_{}", Uuid::new_v4().simple()),
        name: workspace.name.trim().to_owned(),
        directory: workspace.directory,
        shell: workspace.shell,
        startup_commands: workspace.startup_commands,
        ssh_target: workspace.ssh_target,
        archived: false,
        created_at: now,
        updated_at: now,
    };
    state
        .registry
        .lock()
        .map_err(|_| "registry lock failed")?
        .workspaces
        .push(saved.clone());
    state.persist()?;
    Ok(saved)
}

#[tauri::command]
fn update_workspace(
    id: String,
    workspace: CreateWorkspace,
    state: State<'_, AppState>,
) -> Result<Workspace, String> {
    validate_workspace_for_save(&workspace)?;
    let updated = {
        let mut registry = state.registry.lock().map_err(|_| "registry lock failed")?;
        let saved = registry
            .workspaces
            .iter_mut()
            .find(|item| item.id == id)
            .ok_or("workspace not found")?;
        apply_workspace_update(saved, &workspace, Utc::now());
        saved.clone()
    };
    state.persist()?;
    Ok(updated)
}

#[tauri::command]
fn archive_workspace(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut registry = state.registry.lock().map_err(|_| "registry lock failed")?;
    let workspace = registry
        .workspaces
        .iter_mut()
        .find(|workspace| workspace.id == id)
        .ok_or("workspace not found")?;
    workspace.archived = true;
    workspace.updated_at = Utc::now();
    drop(registry);
    state.persist()
}

#[tauri::command]
fn list_remote_grants(state: State<'_, AppState>) -> Result<Vec<RemoteGrantSummary>, String> {
    Ok(state
        .registry
        .lock()
        .map_err(|_| "registry lock failed")?
        .remote_grants
        .iter()
        .map(remote_grant_summary)
        .collect())
}

#[tauri::command]
fn create_remote_grant(
    grant: CreateRemoteGrant,
    state: State<'_, AppState>,
) -> Result<IssuedRemoteGrant, String> {
    // UUID v4 supplies 122 bits of OS-random entropy. The value is returned
    // exactly once, while only its SHA-256 verifier reaches persistent state.
    let secret = format!("tdg_{}", Uuid::new_v4().simple());
    let (stored, issued) = issue_remote_grant(
        format!("grant_{}", Uuid::new_v4().simple()),
        &grant,
        secret,
        Utc::now(),
    )
    .map_err(|error| error.to_string())?;
    state
        .registry
        .lock()
        .map_err(|_| "registry lock failed")?
        .remote_grants
        .push(stored);
    state.persist()?;
    Ok(issued)
}

#[tauri::command]
fn revoke_remote_grant(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut registry = state.registry.lock().map_err(|_| "registry lock failed")?;
    let initial = registry.remote_grants.len();
    registry.remote_grants.retain(|grant| grant.id != id);
    if registry.remote_grants.len() == initial {
        return Err("remote grant not found".into());
    }
    drop(registry);
    state.persist()
}

#[tauri::command]
fn launch_workspace(
    workspace_id: String,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<Session, String> {
    let workspace = state
        .registry
        .lock()
        .map_err(|_| "registry lock failed")?
        .workspaces
        .iter()
        .find(|workspace| workspace.id == workspace_id && !workspace.archived)
        .cloned()
        .ok_or("workspace not found")?;
    let pty = native_pty_system()
        .openpty(PtySize {
            rows: 36,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("could not allocate terminal: {error}"))?;
    let command = build_pty_command(&workspace)?;
    let child = pty
        .slave
        .spawn_command(command)
        .map_err(|error| format!("could not launch shell: {error}"))?;
    let master = pty.master;
    let mut reader = master
        .try_clone_reader()
        .map_err(|error| format!("could not observe terminal: {error}"))?;
    let writer = master
        .take_writer()
        .map_err(|error| format!("could not attach terminal input: {error}"))?;
    let session = Session {
        id: format!("sess_{}", Uuid::new_v4().simple()),
        workspace_id,
        state: SessionState::Running,
        started_at: Utc::now(),
        last_activity_at: Utc::now(),
        exit_code: None,
        output_preview: "Terminal session started.".into(),
        cursor: 0,
        output_truncated: false,
        activity: Some(Activity {
            state: SessionState::Running,
            confidence: ActivityConfidence::Fact,
            reason: "PTY started".into(),
        }),
    };
    state
        .runtime
        .lock()
        .map_err(|_| "process lock failed")?
        .insert(
            session.id.clone(),
            RuntimeSession {
                child,
                master,
                writer,
                controller_attachment: None,
            },
        );
    state
        .registry
        .lock()
        .map_err(|_| "registry lock failed")?
        .sessions
        .insert(0, session.clone());
    state.persist()?;
    let registry = Arc::clone(&state.registry);
    let reader_event_history = Arc::clone(&state.event_history);
    let reader_persistence_lock = Arc::clone(&state.persistence_lock);
    let reader_path = state.registry_path.clone();
    let session_id = session.id.clone();
    let reader_app = app.clone();
    thread::spawn(move || {
        let mut buffer = [0_u8; 1024];
        // Keep a bounded restart-recovery preview durable without writing on
        // every terminal byte. The final checkpoint runs when the PTY reader
        // closes, so ordinary session shutdowns do not lose the last chunk.
        let mut last_persist = Instant::now() - OUTPUT_PERSIST_INTERVAL;
        while let Ok(read) = reader.read(&mut buffer) {
            if read == 0 {
                break;
            }
            let chunk = String::from_utf8_lossy(&buffer[..read]);
            let mut wrote_session = false;
            if let Ok(mut registry_guard) = registry.lock() {
                if let Some(item) = registry_guard
                    .sessions
                    .iter_mut()
                    .find(|item| item.id == session_id)
                {
                    wrote_session = true;
                    item.last_activity_at = Utc::now();
                    let output = format!("{}{}", item.output_preview, chunk);
                    let (tail, truncated) = bounded_tail(&output, MAX_PREVIEW_CHARS);
                    item.output_preview = tail;
                    item.output_truncated |= truncated;
                    item.cursor = item.cursor.saturating_add(1);
                    let output_cursor = item.cursor;
                    let (next_state, confidence, reason) =
                        if output_suggests_attention(&item.output_preview) {
                            (
                                SessionState::Attention,
                                ActivityConfidence::Inference,
                                "Explicit confirmation prompt in terminal output",
                            )
                        } else {
                            (
                                SessionState::Running,
                                ActivityConfidence::Fact,
                                "Recent terminal output",
                            )
                        };
                    let state_event = if !matches!(
                        item.state,
                        SessionState::Exited | SessionState::Disconnected
                    ) {
                        let changed = item.state != next_state;
                        item.state = next_state.clone();
                        item.activity = Some(Activity {
                            state: next_state.clone(),
                            confidence,
                            reason: reason.into(),
                        });
                        if changed {
                            item.cursor = item.cursor.saturating_add(1);
                            Some((item.cursor, next_state))
                        } else {
                            None
                        }
                    } else {
                        None
                    };
                    let _ = publish_session_event(
                        &reader_event_history,
                        &reader_app,
                        SessionEvent::Output {
                            session_id: session_id.clone(),
                            cursor: output_cursor,
                            data: chunk.into_owned(),
                        },
                    );
                    if let Some((cursor, state)) = state_event {
                        let _ = publish_session_event(
                            &reader_event_history,
                            &reader_app,
                            SessionEvent::State {
                                session_id: session_id.clone(),
                                cursor,
                                state,
                            },
                        );
                    }
                }
            }
            if wrote_session && last_persist.elapsed() >= OUTPUT_PERSIST_INTERVAL {
                let _ = persist_registry(&registry, &reader_path, &reader_persistence_lock);
                last_persist = Instant::now();
            }
        }
        let _ = persist_registry(&registry, &reader_path, &reader_persistence_lock);
    });
    let monitor_runtime = Arc::clone(&state.runtime);
    let monitor_publisher = SessionStatePublisher {
        registry: Arc::clone(&state.registry),
        event_history: Arc::clone(&state.event_history),
        persistence_lock: Arc::clone(&state.persistence_lock),
        registry_path: state.registry_path.clone(),
        app,
    };
    let monitor_session_id = session.id.clone();
    thread::spawn(move || loop {
        let observation = {
            let mut runtime = match monitor_runtime.lock() {
                Ok(runtime) => runtime,
                Err(_) => return,
            };
            let Some(runtime_session) = runtime.get_mut(&monitor_session_id) else {
                return;
            };
            let observation = match runtime_session.child.try_wait() {
                Ok(Some(status)) => {
                    ChildObservation::Exited(status.exit_code().min(i32::MAX as u32) as i32)
                }
                Ok(None) => ChildObservation::Running,
                Err(_) => ChildObservation::Disconnected,
            };
            if !matches!(observation, ChildObservation::Running) {
                runtime.remove(&monitor_session_id);
            }
            observation
        };
        match observation {
            ChildObservation::Running => {
                let _ = monitor_publisher.publish(&monitor_session_id, SessionState::Quiet, None);
                thread::sleep(LIFECYCLE_POLL_INTERVAL);
            }
            ChildObservation::Exited(exit_code) => {
                let _ = monitor_publisher.publish(
                    &monitor_session_id,
                    SessionState::Exited,
                    Some(exit_code),
                );
                return;
            }
            ChildObservation::Disconnected => {
                let _ = monitor_publisher.publish(
                    &monitor_session_id,
                    SessionState::Disconnected,
                    None,
                );
                return;
            }
        }
    });
    Ok(session)
}

#[tauri::command]
fn attach_session(
    session_id: String,
    access: SessionAccess,
    state: State<'_, AppState>,
) -> Result<SessionAttachment, String> {
    let registry = state.registry.lock().map_err(|_| "registry lock failed")?;
    let session = registry
        .sessions
        .iter()
        .find(|session| session.id == session_id)
        .cloned()
        .ok_or("session not found")?;
    if matches!(
        session.state,
        SessionState::Exited | SessionState::Disconnected
    ) {
        return Err("session is not currently attachable on this local host".into());
    }
    drop(registry);
    let attachment_id = if access == SessionAccess::Control {
        let mut runtime = state.runtime.lock().map_err(|_| "process lock failed")?;
        let runtime_session = runtime
            .get_mut(&session_id)
            .ok_or("session is not running on this local host")?;
        let attachment_id = format!("attach_{}", Uuid::new_v4().simple());
        claim_controller_attachment(
            &mut runtime_session.controller_attachment,
            attachment_id.clone(),
        )
        .map_err(|error| error.to_string())?;
        Some(attachment_id)
    } else {
        None
    };
    Ok(SessionAttachment {
        protocol_version: term_dock_lib::BROKER_PROTOCOL_VERSION.to_owned(),
        cursor: session.cursor,
        output: session.output_preview.clone(),
        output_truncated: session.output_truncated,
        session,
        access,
        attachment_id,
    })
}

#[tauri::command]
fn replay_session_events(
    session_id: String,
    cursor: u64,
    state: State<'_, AppState>,
) -> Result<SessionEventReplay, String> {
    let latest_cursor = state
        .registry
        .lock()
        .map_err(|_| "registry lock failed")?
        .sessions
        .iter()
        .find(|session| session.id == session_id)
        .ok_or("session not found")?
        .cursor;
    let history = state
        .event_history
        .lock()
        .map_err(|_| "event history lock failed")?;
    Ok(history
        .get(&session_id)
        .map(|events| events.replay_from(cursor, latest_cursor))
        .unwrap_or_else(|| SessionEventHistory::default().replay_from(cursor, latest_cursor)))
}

#[tauri::command]
fn detach_session(
    session_id: String,
    attachment_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut runtime = state.runtime.lock().map_err(|_| "process lock failed")?;
    let session = controller_runtime_session(&mut runtime, &session_id, &attachment_id)?;
    release_controller_attachment(&mut session.controller_attachment, &attachment_id)
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn write_session_input(
    session_id: String,
    attachment_id: String,
    data: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    validate_terminal_input(&data).map_err(|error| error.to_string())?;
    let mut runtime = state.runtime.lock().map_err(|_| "process lock failed")?;
    let session = controller_runtime_session(&mut runtime, &session_id, &attachment_id)?;
    session
        .writer
        .write_all(data.as_bytes())
        .and_then(|_| session.writer.flush())
        .map_err(|error| format!("could not write terminal input: {error}"))
}

#[tauri::command]
fn resize_session(
    session_id: String,
    attachment_id: String,
    size: TerminalSize,
    state: State<'_, AppState>,
) -> Result<(), String> {
    validate_terminal_size(&size).map_err(|error| error.to_string())?;
    let mut runtime = state.runtime.lock().map_err(|_| "process lock failed")?;
    let session = controller_runtime_session(&mut runtime, &session_id, &attachment_id)?;
    session
        .master
        .resize(PtySize {
            rows: size.rows,
            cols: size.columns,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("could not resize terminal: {error}"))
}

#[tauri::command]
fn terminate_session(
    session_id: String,
    attachment_id: String,
    confirmed: bool,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    if !confirmed {
        return Err("termination requires explicit confirmation".into());
    }
    let mut runtime = state.runtime.lock().map_err(|_| "process lock failed")?;
    {
        let session = controller_runtime_session(&mut runtime, &session_id, &attachment_id)?;
        session
            .child
            .kill()
            .map_err(|error| format!("could not terminate terminal: {error}"))?;
    }
    runtime.remove(&session_id);
    drop(runtime);
    SessionStatePublisher {
        registry: Arc::clone(&state.registry),
        event_history: Arc::clone(&state.event_history),
        persistence_lock: Arc::clone(&state.persistence_lock),
        registry_path: state.registry_path.clone(),
        app,
    }
    .publish(&session_id, SessionState::Exited, None)
}

#[tauri::command]
fn get_ai_context(workspace_id: String, state: State<'_, AppState>) -> Result<AiContext, String> {
    let registry = state.registry.lock().map_err(|_| "registry lock failed")?;
    let workspace = registry
        .workspaces
        .iter()
        .find(|workspace| workspace.id == workspace_id)
        .ok_or("workspace not found")?;
    Ok(build_ai_context(
        workspace,
        registry
            .sessions
            .iter()
            .filter(|session| session.workspace_id == workspace_id)
            .cloned(),
    ))
}

#[tauri::command]
fn parse_deep_link(url: String) -> Result<DeepLinkTarget, String> {
    parse_safe_deep_link(&url).map_err(|error| error.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            app.manage(load_state(app)?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_workspaces,
            list_sessions,
            create_workspace,
            update_workspace,
            archive_workspace,
            list_remote_grants,
            create_remote_grant,
            revoke_remote_grant,
            launch_workspace,
            attach_session,
            replay_session_events,
            detach_session,
            write_session_input,
            resize_session,
            terminate_session,
            get_ai_context,
            parse_deep_link
        ])
        .run(tauri::generate_context!())
        .expect("error while running Term Dock");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_checkpoint_preserves_bounded_output_preview() {
        let path = env::temp_dir().join(format!("term-dock-{}.json", Uuid::new_v4()));
        let registry = Mutex::new(Registry {
            sessions: vec![Session {
                id: "sess_checkpoint".into(),
                workspace_id: "ws_checkpoint".into(),
                state: SessionState::Running,
                started_at: Utc::now(),
                last_activity_at: Utc::now(),
                exit_code: None,
                output_preview: "recent bounded terminal output".into(),
                cursor: 4,
                output_truncated: true,
                activity: None,
            }],
            ..Registry::default()
        });
        let persistence_lock = Mutex::new(());

        persist_registry(&registry, &path, &persistence_lock).unwrap();

        let recovered: Registry = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            recovered.sessions[0].output_preview,
            "recent bounded terminal output"
        );
        assert!(recovered.sessions[0].output_truncated);
        fs::remove_file(path).unwrap();
    }
}
