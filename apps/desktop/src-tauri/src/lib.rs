//! Pure domain rules for Term Dock. Keeping these independent of Tauri makes
//! the product's security boundary easy to test and reuse by future clients.

use std::collections::VecDeque;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use thiserror::Error;
use url::Url;

pub const AI_CONTEXT_VERSION: &str = "term-dock.ai-context/v1";
/// Stable wire contract for every terminal client: native, browser, or a
/// future authenticated remote companion. Transport is deliberately absent.
pub const BROKER_PROTOCOL_VERSION: &str = "term-dock.broker/v1";
pub const MAX_TERMINAL_INPUT_BYTES: usize = 64 * 1024;
pub const MAX_TERMINAL_ROWS: u16 = 500;
pub const MAX_TERMINAL_COLUMNS: u16 = 1_000;
/// The live host retains a small, in-memory stream window for reconnecting
/// clients. Durable recovery remains the attachment snapshot, not a log.
pub const MAX_SESSION_EVENT_REPLAY_EVENTS: usize = 256;
pub const MAX_SESSION_EVENT_REPLAY_BYTES: usize = 64 * 1024;
/// A deterministic activity fact. Prompt detection remains a separate,
/// explicitly labelled inference.
pub const QUIET_AFTER_SECONDS: i64 = 30;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub directory: String,
    pub shell: String,
    pub startup_commands: Vec<String>,
    pub ssh_target: Option<String>,
    pub archived: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorkspace {
    pub name: String,
    pub directory: String,
    pub shell: String,
    pub startup_commands: Vec<String>,
    pub ssh_target: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionState {
    Running,
    Quiet,
    Attention,
    Exited,
    Disconnected,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ActivityConfidence {
    Fact,
    Inference,
}

/// Explains why a session has its displayed state. This is portable metadata,
/// not terminal transcript, and allows local, browser, and remote clients to
/// present facts differently from low-confidence inferences.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub state: SessionState,
    pub confidence: ActivityConfidence,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub workspace_id: String,
    pub state: SessionState,
    pub started_at: DateTime<Utc>,
    pub last_activity_at: DateTime<Utc>,
    pub exit_code: Option<i32>,
    pub output_preview: String,
    #[serde(default)]
    pub cursor: u64,
    #[serde(default)]
    pub output_truncated: bool,
    #[serde(default)]
    pub activity: Option<Activity>,
}

/// A browser or remote client must explicitly state whether it needs an
/// interactive controller lease or a read-only view. The host remains the
/// authority that decides whether such a lease can be granted.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionAccess {
    View,
    Control,
}

/// A persisted device grant intentionally contains only a verifier. The
/// one-time secret is returned at creation and is never written to disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteGrant {
    pub id: String,
    pub device_label: String,
    pub access: SessionAccess,
    pub created_at: DateTime<Utc>,
    pub expires_at: Option<DateTime<Utc>>,
    /// Set only when the displayed enrollment secret is exchanged by a
    /// companion. Existing registry files deserialize this as `None`.
    #[serde(default)]
    pub consumed_at: Option<DateTime<Utc>>,
    pub token_hash: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRemoteGrant {
    pub device_label: String,
    pub access: SessionAccess,
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteGrantSummary {
    pub id: String,
    pub device_label: String,
    pub access: SessionAccess,
    pub created_at: DateTime<Utc>,
    pub expires_at: Option<DateTime<Utc>>,
    pub consumed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuedRemoteGrant {
    pub grant: RemoteGrantSummary,
    /// Display only once to the user. It is never present in a later list,
    /// attachment, AI context, deep link, or workspace record.
    pub secret: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSize {
    pub rows: u16,
    pub columns: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionAttachment {
    pub protocol_version: String,
    pub session: Session,
    pub access: SessionAccess,
    /// Opaque runtime-only capability for a granted controller. It is absent
    /// from view attachments and deliberately never persisted in `Registry`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment_id: Option<String>,
    /// Monotonically increasing per-session position for a future streaming
    /// transport. `0` denotes the bounded snapshot included here.
    pub cursor: u64,
    pub output: String,
    pub output_truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum SessionEvent {
    Output {
        session_id: String,
        cursor: u64,
        data: String,
    },
    State {
        session_id: String,
        cursor: u64,
        state: SessionState,
    },
}

impl SessionEvent {
    pub fn session_id(&self) -> &str {
        match self {
            Self::Output { session_id, .. } | Self::State { session_id, .. } => session_id,
        }
    }

    pub fn cursor(&self) -> u64 {
        match self {
            Self::Output { cursor, .. } | Self::State { cursor, .. } => *cursor,
        }
    }

    fn replay_cost(&self) -> usize {
        match self {
            Self::Output {
                session_id, data, ..
            } => 32 + session_id.len() + data.len(),
            Self::State { session_id, .. } => 48 + session_id.len(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEventReplay {
    pub events: Vec<SessionEvent>,
    pub latest_cursor: u64,
    pub truncated: bool,
}

/// Runtime-only, bounded event history. It is deliberately excluded from the
/// registry so terminal bytes do not become an unbounded durable transcript.
#[derive(Debug, Default)]
pub struct SessionEventHistory {
    events: VecDeque<SessionEvent>,
    replay_bytes: usize,
}

impl SessionEventHistory {
    pub fn push(&mut self, event: SessionEvent) {
        self.replay_bytes = self.replay_bytes.saturating_add(event.replay_cost());
        self.events.push_back(event);
        while self.events.len() > MAX_SESSION_EVENT_REPLAY_EVENTS
            || self.replay_bytes > MAX_SESSION_EVENT_REPLAY_BYTES
        {
            let Some(removed) = self.events.pop_front() else {
                break;
            };
            self.replay_bytes = self.replay_bytes.saturating_sub(removed.replay_cost());
        }
    }

    pub fn replay_from(&self, cursor: u64, latest_cursor: u64) -> SessionEventReplay {
        let truncated = if cursor >= latest_cursor {
            false
        } else {
            self.events
                .front()
                .is_none_or(|event| event.cursor() > cursor.saturating_add(1))
        };
        SessionEventReplay {
            events: self
                .events
                .iter()
                .filter(|event| event.cursor() > cursor)
                .cloned()
                .collect(),
            latest_cursor,
            truncated,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiContext {
    pub version: &'static str,
    pub workspace: AiWorkspace,
    pub sessions: Vec<AiSession>,
    pub privacy: AiPrivacy,
    pub suggested_prompt: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiWorkspace {
    pub id: String,
    pub name: String,
    pub directory: String,
    pub shell: String,
    pub ssh_target: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSession {
    pub id: String,
    pub state: SessionState,
    pub started_at: DateTime<Utc>,
    pub last_activity_at: DateTime<Utc>,
    pub exit_code: Option<i32>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiPrivacy {
    pub terminal_output_included: bool,
    pub secrets_included: bool,
    pub generated_locally: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeepLinkTarget {
    pub workspace_id: String,
    pub session_id: Option<String>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum DomainError {
    #[error("workspace name must be between 1 and 80 characters")]
    InvalidName,
    #[error("directory and shell must be absolute paths")]
    RelativePath,
    #[error("SSH target must be a host alias or user@host without whitespace or options")]
    InvalidSshTarget,
    #[error("workspace identifiers may only contain letters, digits, hyphens, and underscores")]
    InvalidIdentifier,
    #[error("unsupported deep link; only term-dock://workspace/<id> is accepted")]
    InvalidDeepLink,
    #[error("terminal size must be between 1×1 and 500×1000")]
    InvalidTerminalSize,
    #[error("terminal input exceeds the 64 KiB message limit")]
    InputTooLarge,
    #[error("remote device label must be between 1 and 80 characters")]
    InvalidDeviceLabel,
    #[error("remote grant expiry must be in the future")]
    InvalidGrantExpiry,
    #[error("remote grant secret is invalid, expired, or unavailable")]
    RemoteGrantUnavailable,
    #[error("remote grant has already been exchanged")]
    RemoteGrantConsumed,
    #[error("session already has an active controller attachment")]
    ControllerAlreadyAttached,
    #[error("controller attachment is not authorized for this session")]
    UnauthorizedControllerAttachment,
}

/// Claim the single controller lease for a live session. The caller owns the
/// generated opaque ID; only this in-memory slot retains its verifier.
pub fn claim_controller_attachment(
    slot: &mut Option<String>,
    attachment_id: String,
) -> Result<(), DomainError> {
    if slot.is_some() {
        return Err(DomainError::ControllerAlreadyAttached);
    }
    *slot = Some(attachment_id);
    Ok(())
}

pub fn controller_attachment_is_authorized(slot: &Option<String>, attachment_id: &str) -> bool {
    slot.as_deref() == Some(attachment_id)
}

/// Release only the matching controller capability; a stale or viewer token
/// must never clear another client's lease.
pub fn release_controller_attachment(
    slot: &mut Option<String>,
    attachment_id: &str,
) -> Result<(), DomainError> {
    if !controller_attachment_is_authorized(slot, attachment_id) {
        return Err(DomainError::UnauthorizedControllerAttachment);
    }
    *slot = None;
    Ok(())
}

pub fn validate_workspace(input: &CreateWorkspace) -> Result<(), DomainError> {
    if input.name.trim().is_empty() || input.name.chars().count() > 80 {
        return Err(DomainError::InvalidName);
    }
    if !input.directory.starts_with('/') || !input.shell.starts_with('/') {
        return Err(DomainError::RelativePath);
    }
    if let Some(target) = &input.ssh_target {
        validate_ssh_target(target)?;
    }
    Ok(())
}

/// SSH targets are deliberately limited to aliases and user@host forms. Port,
/// identity, jump-host, and forwarding policy belong in the user's SSH config,
/// so workspace data can never be interpreted as an SSH option list.
pub fn validate_ssh_target(target: &str) -> Result<(), DomainError> {
    let bytes = target.as_bytes();
    let valid = !bytes.is_empty()
        && bytes.len() <= 253
        && !target.starts_with('-')
        && bytes.iter().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(byte, b'@' | b'.' | b'_' | b'-' | b':' | b'[' | b']')
        })
        && bytes.iter().filter(|byte| **byte == b'@').count() <= 1;
    if valid {
        Ok(())
    } else {
        Err(DomainError::InvalidSshTarget)
    }
}

fn posix_shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

/// Produces one remote-shell argument for `ssh`, quoting fields that are data
/// while preserving startup commands as the user's explicit executable setup.
pub fn build_remote_shell_command(
    directory: &str,
    shell: &str,
    startup_commands: &[String],
) -> String {
    let mut command = format!("cd -- {}", posix_shell_quote(directory));
    if !startup_commands.is_empty() {
        command.push_str(" && ");
        command.push_str(&startup_commands.join("\n"));
    }
    command.push_str("\nexec ");
    command.push_str(&posix_shell_quote(shell));
    command.push_str(" -l");
    command
}

/// Updating a workspace changes only its launch definition. Its stable ID,
/// archive state, creation time, and sessions remain durable across native,
/// browser, and remote clients.
pub fn apply_workspace_update(
    workspace: &mut Workspace,
    input: &CreateWorkspace,
    now: DateTime<Utc>,
) {
    workspace.name = input.name.trim().to_owned();
    workspace.directory = input.directory.clone();
    workspace.shell = input.shell.clone();
    workspace.startup_commands = input.startup_commands.clone();
    workspace.ssh_target = input.ssh_target.clone();
    workspace.updated_at = now;
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// Parse navigation-only deep links. No executable intent, credentials, or
/// arbitrary query parameters are accepted by the boundary.
pub fn parse_deep_link(raw: &str) -> Result<DeepLinkTarget, DomainError> {
    let url = Url::parse(raw).map_err(|_| DomainError::InvalidDeepLink)?;
    if url.scheme() != "term-dock" || url.host_str() != Some("workspace") || url.port().is_some() {
        return Err(DomainError::InvalidDeepLink);
    }
    let mut parts = url.path_segments().ok_or(DomainError::InvalidDeepLink)?;
    let workspace_id = parts.next().ok_or(DomainError::InvalidDeepLink)?;
    if parts.next().is_some() || !valid_id(workspace_id) {
        return Err(DomainError::InvalidIdentifier);
    }
    let mut session_id = None;
    for (key, value) in url.query_pairs() {
        if key != "session" || session_id.is_some() || !valid_id(&value) {
            return Err(DomainError::InvalidDeepLink);
        }
        session_id = Some(value.into_owned());
    }
    Ok(DeepLinkTarget {
        workspace_id: workspace_id.to_owned(),
        session_id,
    })
}

pub fn build_ai_context(
    workspace: &Workspace,
    sessions: impl IntoIterator<Item = Session>,
) -> AiContext {
    AiContext {
        version: AI_CONTEXT_VERSION,
        workspace: AiWorkspace { id: workspace.id.clone(), name: workspace.name.clone(), directory: workspace.directory.clone(), shell: workspace.shell.clone(), ssh_target: workspace.ssh_target.clone() },
        sessions: sessions.into_iter().map(|session| AiSession { id: session.id, state: session.state, started_at: session.started_at, last_activity_at: session.last_activity_at, exit_code: session.exit_code }).collect(),
        privacy: AiPrivacy { terminal_output_included: false, secrets_included: false, generated_locally: true },
        suggested_prompt: format!("Help me continue work in {}. Ask before suggesting commands that modify files or processes.", workspace.name),
    }
}

pub fn validate_terminal_size(size: &TerminalSize) -> Result<(), DomainError> {
    if size.rows == 0
        || size.columns == 0
        || size.rows > MAX_TERMINAL_ROWS
        || size.columns > MAX_TERMINAL_COLUMNS
    {
        return Err(DomainError::InvalidTerminalSize);
    }
    Ok(())
}

pub fn validate_terminal_input(data: &str) -> Result<(), DomainError> {
    if data.len() > MAX_TERMINAL_INPUT_BYTES {
        return Err(DomainError::InputTooLarge);
    }
    Ok(())
}

/// Detect only explicit confirmation-style prompts. This deliberately avoids
/// treating a generic shell prompt as an attention signal.
pub fn output_suggests_attention(output: &str) -> bool {
    let tail = output.trim_end();
    [
        "(y/N)",
        "(Y/n)",
        "[y/N]",
        "[Y/n]",
        "Press Enter to continue",
    ]
    .iter()
    .any(|marker| tail.ends_with(marker))
}

/// Mark a live session quiet only after a fixed period without output. The
/// session becomes running again when new output reaches the broker.
pub fn mark_session_quiet(session: &mut Session, now: DateTime<Utc>) -> bool {
    if session.state != SessionState::Running
        || now.signed_duration_since(session.last_activity_at)
            < chrono::TimeDelta::seconds(QUIET_AFTER_SECONDS)
    {
        return false;
    }
    set_session_activity(
        session,
        SessionState::Quiet,
        ActivityConfidence::Fact,
        "No terminal output for 30 seconds",
    );
    session.cursor = session.cursor.saturating_add(1);
    true
}

/// A process owned by a previous desktop instance cannot be trusted as
/// locally attachable after restart. Preserve its history but expose the
/// truth to every local, web, and remote client.
pub fn mark_session_disconnected(session: &mut Session, now: DateTime<Utc>) -> bool {
    if matches!(
        session.state,
        SessionState::Exited | SessionState::Disconnected
    ) {
        return false;
    }
    set_session_activity(
        session,
        SessionState::Disconnected,
        ActivityConfidence::Fact,
        "The previous local host no longer owns this PTY",
    );
    session.last_activity_at = now;
    session.cursor = session.cursor.saturating_add(1);
    true
}

pub fn mark_session_exited(session: &mut Session, exit_code: Option<i32>, now: DateTime<Utc>) {
    set_session_activity(
        session,
        SessionState::Exited,
        ActivityConfidence::Fact,
        "PTY child process exited",
    );
    session.exit_code = exit_code;
    session.last_activity_at = now;
    session.cursor = session.cursor.saturating_add(1);
}

pub fn set_session_activity(
    session: &mut Session,
    state: SessionState,
    confidence: ActivityConfidence,
    reason: impl Into<String>,
) {
    session.state = state.clone();
    session.activity = Some(Activity {
        state,
        confidence,
        reason: reason.into(),
    });
}

pub fn issue_remote_grant(
    id: String,
    input: &CreateRemoteGrant,
    secret: String,
    now: DateTime<Utc>,
) -> Result<(RemoteGrant, IssuedRemoteGrant), DomainError> {
    if input.device_label.trim().is_empty() || input.device_label.chars().count() > 80 {
        return Err(DomainError::InvalidDeviceLabel);
    }
    if input.expires_at.is_some_and(|expiry| expiry <= now) {
        return Err(DomainError::InvalidGrantExpiry);
    }
    let grant = RemoteGrant {
        id,
        device_label: input.device_label.trim().to_owned(),
        access: input.access.clone(),
        created_at: now,
        expires_at: input.expires_at,
        consumed_at: None,
        token_hash: hash_remote_secret(&secret),
    };
    let issued = IssuedRemoteGrant {
        grant: remote_grant_summary(&grant),
        secret,
    };
    Ok((grant, issued))
}

pub fn remote_grant_summary(grant: &RemoteGrant) -> RemoteGrantSummary {
    RemoteGrantSummary {
        id: grant.id.clone(),
        device_label: grant.device_label.clone(),
        access: grant.access.clone(),
        created_at: grant.created_at,
        expires_at: grant.expires_at,
        consumed_at: grant.consumed_at,
    }
}

pub fn verifies_remote_grant(grant: &RemoteGrant, secret: &str, now: DateTime<Utc>) -> bool {
    if grant.consumed_at.is_some() || grant.expires_at.is_some_and(|expiry| expiry <= now) {
        return false;
    }
    hash_remote_secret(secret)
        .as_bytes()
        .ct_eq(grant.token_hash.as_bytes())
        .into()
}

/// Exchange the one-time displayed secret at a future authenticated companion
/// boundary. The returned scope is used to mint a short-lived attachment
/// token; this durable grant cannot be exchanged a second time.
pub fn consume_remote_grant(
    grants: &mut [RemoteGrant],
    secret: &str,
    now: DateTime<Utc>,
) -> Result<RemoteGrantSummary, DomainError> {
    let hash = hash_remote_secret(secret);
    let grant = grants
        .iter_mut()
        .find(|grant| hash.as_bytes().ct_eq(grant.token_hash.as_bytes()).into())
        .ok_or(DomainError::RemoteGrantUnavailable)?;
    if grant.consumed_at.is_some() {
        return Err(DomainError::RemoteGrantConsumed);
    }
    if grant.expires_at.is_some_and(|expiry| expiry <= now) {
        return Err(DomainError::RemoteGrantUnavailable);
    }
    grant.consumed_at = Some(now);
    Ok(remote_grant_summary(grant))
}

fn hash_remote_secret(secret: &str) -> String {
    let digest = Sha256::digest(secret.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Keep bounded terminal replay valid UTF-8. A client may use this output to
/// paint its initial view before it starts receiving stream events.
pub fn bounded_tail(value: &str, limit: usize) -> (String, bool) {
    if value.len() <= limit {
        return (value.to_owned(), false);
    }
    let mut start = value.len() - limit;
    while !value.is_char_boundary(start) {
        start += 1;
    }
    (value[start..].to_owned(), true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    #[test]
    fn accepts_a_navigation_only_link() {
        assert_eq!(
            parse_deep_link("term-dock://workspace/team_api-1?session=sess_2").unwrap(),
            DeepLinkTarget {
                workspace_id: "team_api-1".into(),
                session_id: Some("sess_2".into())
            }
        );
    }
    #[test]
    fn rejects_deep_link_command_injection() {
        assert!(parse_deep_link("term-dock://workspace/a?command=rm%20-rf%20~").is_err());
    }
    #[test]
    fn ai_context_never_copies_output() {
        let workspace = Workspace {
            id: "a".into(),
            name: "Demo".into(),
            directory: "/tmp".into(),
            shell: "/bin/zsh".into(),
            startup_commands: vec![],
            ssh_target: None,
            archived: false,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };
        let context = build_ai_context(
            &workspace,
            [Session {
                id: "s".into(),
                workspace_id: "a".into(),
                state: SessionState::Running,
                started_at: Utc::now(),
                last_activity_at: Utc::now(),
                exit_code: None,
                output_preview: "super-secret-token".into(),
                cursor: 0,
                output_truncated: false,
                activity: None,
            }],
        );
        assert!(!serde_json::to_string(&context)
            .unwrap()
            .contains("super-secret-token"));
    }

    #[test]
    fn workspace_update_preserves_identity_and_archive_state() {
        let created_at = Utc::now();
        let updated_at = created_at + chrono::TimeDelta::minutes(5);
        let mut workspace = Workspace {
            id: "ws_demo".into(),
            name: "Old name".into(),
            directory: "/tmp/old".into(),
            shell: "/bin/zsh".into(),
            startup_commands: vec!["old".into()],
            ssh_target: None,
            archived: true,
            created_at,
            updated_at: created_at,
        };
        let input = CreateWorkspace {
            name: "  New name  ".into(),
            directory: "/tmp/new".into(),
            shell: "/bin/bash".into(),
            startup_commands: vec!["new".into()],
            ssh_target: Some("host-alias".into()),
        };

        apply_workspace_update(&mut workspace, &input, updated_at);

        assert_eq!(workspace.id, "ws_demo");
        assert!(workspace.archived);
        assert_eq!(workspace.created_at, created_at);
        assert_eq!(workspace.updated_at, updated_at);
        assert_eq!(workspace.name, "New name");
        assert_eq!(workspace.directory, "/tmp/new");
        assert_eq!(workspace.ssh_target.as_deref(), Some("host-alias"));
    }

    #[test]
    fn remote_workspace_target_is_option_safe_and_command_quotes_data() {
        assert!(validate_ssh_target("deploy@build-box").is_ok());
        assert!(validate_ssh_target("-oProxyCommand=bad").is_err());
        assert!(validate_ssh_target("build box").is_err());
        assert!(validate_ssh_target("user@one@two").is_err());

        let command =
            build_remote_shell_command("/srv/it's-safe", "/bin/zsh", &["pnpm dev".into()]);
        assert_eq!(
            command,
            "cd -- '/srv/it'\"'\"'s-safe' && pnpm dev\nexec '/bin/zsh' -l"
        );
    }

    #[test]
    fn terminal_protocol_has_bounded_valid_utf8_replay() {
        let (tail, truncated) = bounded_tail("prefix 💻 terminal", 10);
        assert!(truncated);
        assert_eq!(tail, " terminal");
        assert!(std::str::from_utf8(tail.as_bytes()).is_ok());
    }

    #[test]
    fn validates_terminal_messages_at_the_broker_boundary() {
        assert!(validate_terminal_size(&TerminalSize {
            rows: 36,
            columns: 120
        })
        .is_ok());
        assert!(validate_terminal_size(&TerminalSize {
            rows: 0,
            columns: 120
        })
        .is_err());
        assert!(validate_terminal_input(&"x".repeat(MAX_TERMINAL_INPUT_BYTES)).is_ok());
        assert!(validate_terminal_input(&"x".repeat(MAX_TERMINAL_INPUT_BYTES + 1)).is_err());
    }

    #[test]
    fn monitoring_separates_idle_facts_from_prompt_inference() {
        let now = Utc::now();
        let mut session = Session {
            id: "sess_demo".into(),
            workspace_id: "ws_demo".into(),
            state: SessionState::Running,
            started_at: now,
            last_activity_at: now,
            exit_code: None,
            output_preview: String::new(),
            cursor: 0,
            output_truncated: false,
            activity: None,
        };
        assert!(!output_suggests_attention("build finished\n"));
        assert!(output_suggests_attention("Continue migration? (y/N)"));
        assert!(!mark_session_quiet(
            &mut session,
            now + chrono::TimeDelta::seconds(QUIET_AFTER_SECONDS - 1),
        ));
        assert!(mark_session_quiet(
            &mut session,
            now + chrono::TimeDelta::seconds(QUIET_AFTER_SECONDS),
        ));
        assert_eq!(session.state, SessionState::Quiet);
        assert_eq!(
            session
                .activity
                .as_ref()
                .map(|activity| &activity.confidence),
            Some(&ActivityConfidence::Fact)
        );
        assert_eq!(
            session
                .activity
                .as_ref()
                .map(|activity| activity.reason.as_str()),
            Some("No terminal output for 30 seconds")
        );
    }

    #[test]
    fn session_events_are_tagged_for_cross_client_transports() {
        let event = SessionEvent::Output {
            session_id: "sess_demo".into(),
            cursor: 7,
            data: "ready\n".into(),
        };
        assert_eq!(serde_json::to_value(event).unwrap()["type"], "output");
    }

    #[test]
    fn event_replay_is_cursor_ordered_and_signals_a_bounded_gap() {
        let mut history = SessionEventHistory::default();
        for cursor in 1..=(MAX_SESSION_EVENT_REPLAY_EVENTS as u64 + 1) {
            history.push(SessionEvent::Output {
                session_id: "sess_demo".into(),
                cursor,
                data: "x".into(),
            });
        }

        let stale = history.replay_from(0, MAX_SESSION_EVENT_REPLAY_EVENTS as u64 + 1);
        assert!(stale.truncated);
        assert_eq!(stale.events.first().map(SessionEvent::cursor), Some(2));
        assert_eq!(stale.events.last().map(SessionEvent::cursor), Some(257));

        let current = history.replay_from(256, 257);
        assert!(!current.truncated);
        assert_eq!(current.events.len(), 1);
        assert_eq!(current.events[0].cursor(), 257);
    }

    #[test]
    fn remote_grant_keeps_only_a_verifier_and_respects_expiry() {
        let now = Utc::now();
        let input = CreateRemoteGrant {
            device_label: "Browser on tablet".into(),
            access: SessionAccess::View,
            expires_at: Some(now + chrono::TimeDelta::hours(1)),
        };
        let (stored, issued) =
            issue_remote_grant("grant_demo".into(), &input, "tdg_secret".into(), now).unwrap();
        assert!(!serde_json::to_string(&stored)
            .unwrap()
            .contains("tdg_secret"));
        assert_eq!(issued.secret, "tdg_secret");
        assert!(verifies_remote_grant(&stored, "tdg_secret", now));
        assert!(!verifies_remote_grant(&stored, "wrong", now));
        assert!(!verifies_remote_grant(
            &stored,
            "tdg_secret",
            now + chrono::TimeDelta::hours(2)
        ));
    }

    #[test]
    fn remote_enrollment_secret_can_only_be_exchanged_once() {
        let now = Utc::now();
        let input = CreateRemoteGrant {
            device_label: "Browser on tablet".into(),
            access: SessionAccess::Control,
            expires_at: Some(now + chrono::TimeDelta::hours(1)),
        };
        let (stored, _) =
            issue_remote_grant("grant_demo".into(), &input, "tdg_once".into(), now).unwrap();
        let mut grants = vec![stored];

        let exchanged = consume_remote_grant(&mut grants, "tdg_once", now).unwrap();

        assert_eq!(exchanged.access, SessionAccess::Control);
        assert!(exchanged.consumed_at.is_some());
        assert!(!verifies_remote_grant(&grants[0], "tdg_once", now));
        assert_eq!(
            consume_remote_grant(&mut grants, "tdg_once", now).unwrap_err(),
            DomainError::RemoteGrantConsumed
        );
    }

    #[test]
    fn session_lifecycle_never_leaves_a_stale_running_state() {
        let now = Utc::now();
        let mut session = Session {
            id: "sess_demo".into(),
            workspace_id: "ws_demo".into(),
            state: SessionState::Running,
            started_at: now,
            last_activity_at: now,
            exit_code: None,
            output_preview: String::new(),
            cursor: 4,
            output_truncated: false,
            activity: None,
        };
        assert!(mark_session_disconnected(&mut session, now));
        assert_eq!(session.state, SessionState::Disconnected);
        assert_eq!(
            session
                .activity
                .as_ref()
                .map(|activity| &activity.confidence),
            Some(&ActivityConfidence::Fact)
        );
        assert_eq!(session.cursor, 5);
        assert!(!mark_session_disconnected(&mut session, now));
        mark_session_exited(&mut session, Some(23), now);
        assert_eq!(session.state, SessionState::Exited);
        assert_eq!(session.exit_code, Some(23));
        assert_eq!(session.cursor, 6);
    }

    #[test]
    fn controller_attachment_is_exclusive_and_only_matching_capability_releases_it() {
        let mut lease = None;
        claim_controller_attachment(&mut lease, "attach_first".into()).unwrap();
        assert!(controller_attachment_is_authorized(&lease, "attach_first"));
        assert_eq!(
            claim_controller_attachment(&mut lease, "attach_second".into()).unwrap_err(),
            DomainError::ControllerAlreadyAttached
        );
        assert_eq!(
            release_controller_attachment(&mut lease, "stale").unwrap_err(),
            DomainError::UnauthorizedControllerAttachment
        );
        assert!(controller_attachment_is_authorized(&lease, "attach_first"));
        release_controller_attachment(&mut lease, "attach_first").unwrap();
        assert!(lease.is_none());
    }
}
