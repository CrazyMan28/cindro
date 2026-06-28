export const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    extension TEXT UNIQUE,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    extension TEXT UNIQUE,
    name TEXT NOT NULL,
    token_hash TEXT,
    online INTEGER NOT NULL DEFAULT 0,
    last_seen_at TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS extensions (
    extension TEXT PRIMARY KEY,
    owner_type TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    name TEXT NOT NULL,
    permissions TEXT NOT NULL DEFAULT '{}',
    allowed_callers TEXT NOT NULL DEFAULT '[]',
    online INTEGER NOT NULL DEFAULT 0,
    busy INTEGER NOT NULL DEFAULT 0,
    current_session_id TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    extension TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    adapter_type TEXT NOT NULL,
    permissions TEXT NOT NULL DEFAULT '{}',
    capabilities TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'offline',
    current_task TEXT,
    session_id TEXT,
    last_heartbeat_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS agent_presence (
    agent_id TEXT PRIMARY KEY,
    extension TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL,
    current_task TEXT,
    session_id TEXT,
    last_seen_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    agent_id TEXT,
    repo_path TEXT,
    task TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    summary TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS session_context (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS calls (
    id TEXT PRIMARY KEY,
    from_extension TEXT NOT NULL,
    to_extension TEXT NOT NULL,
    state TEXT NOT NULL,
    reason TEXT,
    urgency TEXT,
    session_id TEXT,
    active_participant TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    accepted_at TEXT,
    ended_at TEXT,
    failure_reason TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS call_participants (
    id TEXT PRIMARY KEY,
    call_id TEXT NOT NULL,
    extension TEXT NOT NULL,
    role TEXT NOT NULL,
    state TEXT NOT NULL,
    joined_at TEXT,
    left_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS call_audio_tracks (
    id TEXT PRIMARY KEY,
    call_id TEXT NOT NULL,
    participant_extension TEXT NOT NULL,
    direction TEXT NOT NULL,
    codec TEXT NOT NULL,
    bytes INTEGER NOT NULL DEFAULT 0,
    raw_audio_path TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    call_id TEXT,
    session_id TEXT,
    from_extension TEXT NOT NULL,
    to_extension TEXT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS transcripts (
    id TEXT PRIMARY KEY,
    call_id TEXT NOT NULL,
    from_extension TEXT NOT NULL,
    text TEXT NOT NULL,
    is_final INTEGER NOT NULL DEFAULT 1,
    confidence REAL,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS tts_outputs (
    id TEXT PRIMARY KEY,
    call_id TEXT,
    message_id TEXT,
    text TEXT NOT NULL,
    model TEXT NOT NULL,
    voice_id TEXT,
    format TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    cache_key TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    actor_extension TEXT,
    call_id TEXT,
    session_id TEXT,
    payload TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS mcp_tool_calls (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    tool_name TEXT NOT NULL,
    args TEXT NOT NULL DEFAULT '{}',
    result TEXT,
    success INTEGER NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS terminal_logs (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    adapter_type TEXT,
    command TEXT,
    output TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    key TEXT NOT NULL,
    content TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    embedding_ref TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS summaries (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    call_id TEXT,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    approval_id TEXT,
    decision TEXT NOT NULL,
    rationale TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    action TEXT NOT NULL,
    risk TEXT NOT NULL,
    command TEXT,
    state TEXT NOT NULL,
    requested_by TEXT,
    response TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    actor TEXT,
    action TEXT NOT NULL,
    target TEXT,
    success INTEGER NOT NULL,
    ip TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS auth_tokens (
    id TEXT PRIMARY KEY,
    owner_type TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    scopes TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    revoked_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS rate_limit_events (
    id TEXT PRIMARY KEY,
    actor TEXT,
    route TEXT NOT NULL,
    ip TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS missed_calls (
    id TEXT PRIMARY KEY,
    call_id TEXT NOT NULL,
    from_extension TEXT NOT NULL,
    to_extension TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    target_extension TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    urgency TEXT NOT NULL DEFAULT 'normal',
    delivered INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS agent_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    session_id TEXT,
    call_id TEXT,
    from_extension TEXT NOT NULL,
    to_extension TEXT NOT NULL,
    from_type TEXT NOT NULL,
    to_type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal',
    status TEXT NOT NULL DEFAULT 'queued',
    requires_response INTEGER NOT NULL DEFAULT 0,
    response_options TEXT NOT NULL DEFAULT '[]',
    response_text TEXT,
    selected_option TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    delivered_at TEXT,
    read_at TEXT,
    replied_at TEXT,
    expires_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS message_threads (
    id TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    related_agent_id TEXT,
    related_extension TEXT,
    latest_message_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_calls_state ON calls(state)`,
  `CREATE INDEX IF NOT EXISTS idx_calls_extensions ON calls(from_extension, to_extension)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_call ON messages(call_id)`,
  `CREATE INDEX IF NOT EXISTS idx_transcripts_call ON transcripts(call_id)`,
  `CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_search ON memories(scope, key)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_messages_thread ON agent_messages(thread_id)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_messages_to ON agent_messages(to_extension, status)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_messages_call ON agent_messages(call_id)`,
  `CREATE INDEX IF NOT EXISTS idx_message_threads_extension ON message_threads(related_extension, status)`,
  `CREATE TABLE IF NOT EXISTS enrollment_bootstrap (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    extension TEXT NOT NULL,
    package_json TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_enrollment_bootstrap_expires ON enrollment_bootstrap(expires_at)`,
  `CREATE TABLE IF NOT EXISTS phone_allowlist (
    id TEXT PRIMARY KEY,
    phone_number TEXT UNIQUE NOT NULL,
    label TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS twilio_calls (
    id TEXT PRIMARY KEY,
    call_id TEXT NOT NULL,
    call_sid TEXT UNIQUE NOT NULL,
    stream_sid TEXT,
    direction TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_twilio_calls_call ON twilio_calls(call_id)`,
  `CREATE TABLE IF NOT EXISTS twilio_sms (
    id TEXT PRIMARY KEY,
    sid TEXT,
    direction TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    message_id TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS twilio_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`
];
