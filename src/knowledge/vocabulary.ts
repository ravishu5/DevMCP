/**
 * Technology vocabulary — the data that replaces an internal LLM call.
 *
 * This MCP performs **zero inference of its own**. If decomposition
 * and query expansion required a model call we would merely be moving the token bill,
 * while adding latency, cost, non-determinism and a second failure mode.
 *
 * So the knowledge lives here, as versioned data:
 *
 *   "background resumable downloads"
 *          ↓ capability match
 *   download · resume · background-execution · queue · retry · persistence
 *          ↓ per-capability expansion (+ stack idioms)
 *   "HTTP Range request" · "WorkManager" · "pause resume download"
 *   "persistent job queue" · "exponential backoff" · "foreground service"
 *
 * That last line is the point: those are terms **the user would not have known to ask
 * for** (spec §20). A model could generate them; a curated table generates them
 * reproducibly, testably, and for free.
 *
 * The table is intentionally shallow and broad. It does not need to describe every
 * technology in existence — it needs to recognise the ~60 capability clusters that
 * dominate application development, and to know their vocabulary well.
 */

export const VOCABULARY_VERSION = "1";

export interface Capability {
  /** Canonical id. Used as the fingerprint key, so it must be stable across versions. */
  id: string;
  label: string;
  category: CapabilityCategory;
  /** Phrases in a requirement that indicate this capability. Matched case-insensitively. */
  triggers: string[];
  /**
   * Search vocabulary. The value of this table is concentrated here: domain terms a user
   * would not know to type.
   */
  searchTerms: string[];
  /**
   * Sub-requirements that a complete implementation of this capability would satisfy.
   * These become the completeness checklist a candidate is scored against.
   */
  checklist: string[];
  /** Whether reuse typically pays off — feeds the Implementation Planner's strategy. */
  reuseValue: "high" | "medium" | "low";
  /** Capabilities usually needed alongside this one. Drives implicit decomposition. */
  implies?: string[];
  /** Foundational capabilities are discovered first and get more budget. */
  foundational?: boolean;
  /**
   * Capabilities this one is a MORE SPECIFIC form of. When both match the same phrase,
   * the narrower wins: "OAuth login" is about OAuth, even though "login" also matches the
   * general auth-session capability.
   */
  narrows?: string[];
  /**
   * GitHub topics to search, when the capability id is a poor topic.
   *
   * Derived topics are usually fine, but some ids are homonyms of something far more
   * popular. `topic:resume` is dominated by CV builders and returned an
   * "ai-resume-analyzer" as a candidate for resumable downloads. Where this is set, it
   * replaces the derived topic entirely.
   */
  topics?: string[];
}

export type CapabilityCategory =
  | "auth" | "networking" | "persistence" | "background" | "ui"
  | "media" | "messaging" | "notifications" | "sync" | "search"
  | "payments" | "analytics" | "infra" | "testing" | "other";

export const CAPABILITIES: Capability[] = [
  // --- networking / transfer ------------------------------------------------
  {
    id: "download", label: "File downloading", category: "networking", reuseValue: "high",
    triggers: ["download", "downloader", "fetch file", "file transfer", "grab file", "save file from"],
    searchTerms: ["file downloader", "download manager", "HTTP download", "streaming download", "chunked download"],
    checklist: ["initiates HTTP download", "writes to storage", "reports progress", "handles large files"],
    implies: ["retry", "progress-reporting"],
  },
  {
    id: "resume", label: "Resumable transfer", category: "networking", reuseValue: "high",
    triggers: ["resume", "resumable", "pause", "pause resume", "continue download", "partial download"],
    // NOT topic:resume — that topic belongs to CV builders and résumé parsers.
    topics: ["resumable-download", "download-manager"],
    // "HTTP Range request" and "206 Partial Content" are exactly the terms a user asking
    // for "pause/resume" would not think to search for.
    searchTerms: ["HTTP Range request", "resumable download", "partial content 206", "byte range transfer", "pause resume download"],
    checklist: ["sends Range header", "persists byte offset", "resumes after interruption", "validates ETag or Last-Modified"],
    implies: ["persistence"],
  },
  {
    id: "upload", label: "File upload", category: "networking", reuseValue: "high",
    triggers: ["upload", "uploader", "multipart", "send file", "media upload"],
    searchTerms: ["multipart upload", "resumable upload", "chunked upload", "tus protocol", "presigned upload"],
    checklist: ["multipart encoding", "progress reporting", "retry on failure", "chunked for large files"],
    implies: ["retry", "progress-reporting"],
  },
  {
    id: "http-client", label: "HTTP client layer", category: "networking", reuseValue: "high", foundational: true,
    triggers: ["http", "rest", "api client", "networking", "web request", "network layer"],
    searchTerms: ["HTTP client", "REST client", "API client wrapper", "interceptor", "connection pooling"],
    checklist: ["configurable base URL", "header/interceptor support", "timeout configuration", "error mapping"],
  },
  {
    id: "websocket", label: "WebSocket / realtime", category: "networking", reuseValue: "high",
    triggers: ["websocket", "realtime", "real-time", "live update", "socket", "push connection", "sse"],
    searchTerms: ["WebSocket reconnection", "exponential backoff reconnect", "heartbeat ping pong", "socket lifecycle", "server-sent events"],
    checklist: ["connect and handshake", "automatic reconnection", "heartbeat/keepalive", "message queueing while offline", "backoff on repeated failure"],
    implies: ["retry"],
  },
  {
    id: "retry", label: "Retry & backoff", category: "networking", reuseValue: "medium",
    triggers: ["retry", "backoff", "resilience", "transient failure", "flaky network"],
    topics: ["retry", "resilience"],
    searchTerms: ["exponential backoff", "retry policy", "circuit breaker", "jittered retry", "retry with backoff"],
    checklist: ["bounded retry count", "exponential backoff", "jitter", "distinguishes retryable errors"],
  },
  {
    id: "offline-sync", label: "Offline sync", category: "sync", reuseValue: "high",
    triggers: ["offline", "sync", "synchronis", "synchroniz", "conflict resolution", "eventual consistency"],
    searchTerms: ["offline first sync", "conflict resolution strategy", "operational transform", "CRDT sync", "delta sync"],
    checklist: ["local write queue", "conflict detection", "conflict resolution policy", "reconciliation on reconnect"],
    implies: ["persistence", "retry"],
  },

  // --- background execution -------------------------------------------------
  {
    id: "background-execution", label: "Background execution", category: "background", reuseValue: "high",
    triggers: ["background", "worker", "daemon", "long running", "foreground service", "job"],
    topics: ["background-tasks", "workmanager"],
    searchTerms: ["background worker", "job scheduler", "WorkManager", "foreground service", "background task"],
    checklist: ["survives app backgrounding", "respects OS constraints", "reports progress", "cancellable"],
    implies: ["queue"],
  },
  {
    id: "queue", label: "Job / task queue", category: "background", reuseValue: "high",
    triggers: ["queue", "job queue", "task queue", "scheduler", "pipeline", "work queue"],
    topics: ["job-queue", "task-queue"],
    searchTerms: ["persistent job queue", "priority queue worker", "task scheduler", "durable queue", "work queue implementation"],
    checklist: ["enqueue and dequeue", "priority or ordering", "concurrency limit", "survives restart", "failure handling"],
    implies: ["persistence"],
  },
  {
    id: "progress-reporting", label: "Progress reporting", category: "ui", reuseValue: "medium",
    triggers: ["progress", "percentage", "progress bar", "status update"],
    topics: ["progress-bar"],
    searchTerms: ["progress reporting", "progress listener", "throttled progress updates"],
    checklist: ["emits progress events", "throttles update frequency", "reports completion and failure"],
  },

  // --- persistence ----------------------------------------------------------
  {
    id: "persistence", label: "Local persistence", category: "persistence", reuseValue: "high", foundational: true,
    // "persistent" does not stem to "persist", so it is listed explicitly — stemming
    // handles inflection, not derivation.
    triggers: ["persist", "persistent", "persistence", "database", "storage", "local store", "save state", "sqlite", "room", "core data"],
    topics: ["orm", "database"],
    searchTerms: ["local database", "ORM", "persistence layer", "migration support", "DAO pattern"],
    checklist: ["schema definition", "CRUD operations", "migrations", "transactional writes"],
  },
  {
    id: "caching", label: "Caching", category: "persistence", reuseValue: "high",
    triggers: ["cache", "caching", "memoiz", "lru", "invalidation"],
    searchTerms: ["LRU cache", "disk cache", "cache invalidation strategy", "two-level cache", "TTL cache"],
    checklist: ["eviction policy", "TTL or invalidation", "size bounds", "cache key derivation"],
  },
  {
    id: "file-storage", label: "File / scoped storage", category: "persistence", reuseValue: "medium",
    triggers: ["scoped storage", "file system", "saf", "documents", "external storage", "blob storage"],
    searchTerms: ["scoped storage", "Storage Access Framework", "file provider", "object storage client"],
    checklist: ["permission handling", "path resolution", "cleanup of partial files"],
  },

  // --- auth -----------------------------------------------------------------
  {
    id: "oauth", label: "OAuth / social login", category: "auth", reuseValue: "high", foundational: true,
    triggers: ["oauth", "google sign", "sign in with", "social login", "openid", "sso", "third party login", "authentication provider"],
    narrows: ["auth-session"],
    topics: ["oauth2", "oauth"],
    searchTerms: ["OAuth2 PKCE flow", "OpenID Connect client", "Google Sign-In integration", "authorization code flow", "token refresh"],
    checklist: ["authorization code + PKCE", "token exchange", "refresh token rotation", "secure token storage", "logout/revocation"],
    implies: ["secure-storage"],
  },
  {
    id: "auth-session", label: "Authentication & sessions", category: "auth", reuseValue: "high", foundational: true,
    triggers: ["auth", "login", "signup", "sign up", "session", "jwt", "authentication", "authenticate", "register", "registration", "password"],
    searchTerms: ["JWT authentication", "session management", "refresh token rotation", "password hashing argon2", "auth middleware"],
    checklist: ["credential verification", "session issuance", "session expiry/refresh", "password hashing", "logout"],
    implies: ["secure-storage"],
  },
  {
    id: "authorization", label: "Authorization / RBAC", category: "auth", reuseValue: "medium",
    triggers: ["permission", "role", "rbac", "access control", "authorization", "authorisation", "authorize", "authorise", "policy"],
    searchTerms: ["RBAC implementation", "policy engine", "attribute based access control", "permission middleware"],
    checklist: ["role definition", "permission checks", "policy evaluation", "deny by default"],
  },
  {
    id: "secure-storage", label: "Secure credential storage", category: "auth", reuseValue: "high",
    triggers: ["keychain", "keystore", "secure storage", "encrypted preferences", "credential store"],
    searchTerms: ["encrypted shared preferences", "Keychain wrapper", "secure token storage", "keystore encryption"],
    checklist: ["hardware-backed where available", "encryption at rest", "key rotation", "no plaintext fallback"],
  },

  // --- messaging / notifications -------------------------------------------
  {
    id: "messaging", label: "Chat / messaging", category: "messaging", reuseValue: "high",
    triggers: ["messaging", "chat", "direct message", "conversation", "instant message"],
    searchTerms: ["chat implementation", "message threading", "read receipts", "typing indicator", "message pagination"],
    checklist: ["send and receive", "ordering and dedup", "delivery/read state", "history pagination", "offline queueing"],
    implies: ["websocket", "persistence"],
  },
  {
    id: "notifications", label: "Push notifications", category: "notifications", reuseValue: "high",
    triggers: ["notification", "notify", "push", "fcm", "apns", "alert", "toast"],
    searchTerms: ["push notification handling", "FCM integration", "notification channel", "deep link from notification", "notification grouping"],
    checklist: ["token registration", "foreground and background handling", "channels/categories", "deep linking", "permission request"],
  },
  {
    id: "feed", label: "Feed / timeline", category: "ui", reuseValue: "medium",
    triggers: ["feed", "timeline", "infinite scroll", "pagination", "news feed"],
    searchTerms: ["paginated feed", "infinite scroll implementation", "cursor pagination", "pull to refresh"],
    checklist: ["cursor or offset pagination", "incremental loading", "refresh", "empty and error states"],
    implies: ["caching"],
  },

  // --- media ----------------------------------------------------------------
  {
    id: "media-playback", label: "Media playback", category: "media", reuseValue: "high",
    triggers: ["video player", "audio player", "playback", "streaming video", "media player"],
    searchTerms: ["ExoPlayer integration", "HLS DASH playback", "adaptive bitrate streaming", "media session"],
    checklist: ["play/pause/seek", "adaptive streaming", "background playback", "lifecycle handling"],
  },
  {
    id: "image-loading", label: "Image loading", category: "media", reuseValue: "high",
    triggers: ["image loading", "thumbnail", "image cache", "avatar", "picture loading"],
    searchTerms: ["image loading library", "disk and memory image cache", "image transformation", "lazy image loading"],
    checklist: ["async loading", "memory and disk cache", "placeholder/error states", "downsampling"],
    implies: ["caching"],
  },
  {
    id: "media-processing", label: "Media processing", category: "media", reuseValue: "medium",
    triggers: ["transcode", "compress video", "resize image", "thumbnail generation", "ffmpeg"],
    searchTerms: ["video transcoding", "image compression", "thumbnail extraction", "media metadata parsing"],
    checklist: ["format conversion", "quality/size control", "progress reporting", "cancellation"],
  },

  // --- infra ----------------------------------------------------------------
  {
    id: "rate-limiting", label: "Rate limiting", category: "infra", reuseValue: "medium",
    triggers: ["rate limit", "throttle", "quota", "leaky bucket", "token bucket"],
    searchTerms: ["token bucket rate limiter", "sliding window rate limit", "distributed rate limiting"],
    checklist: ["per-key limits", "window or bucket algorithm", "graceful rejection", "reset reporting"],
  },
  {
    id: "search-indexing", label: "Search", category: "search", reuseValue: "high",
    triggers: ["search", "full text", "indexing", "elasticsearch", "fuzzy match", "autocomplete"],
    searchTerms: ["full text search", "inverted index", "fuzzy search implementation", "search ranking", "typeahead"],
    checklist: ["indexing pipeline", "query parsing", "ranking", "incremental updates"],
  },
  {
    id: "payments", label: "Payments", category: "payments", reuseValue: "high",
    triggers: ["payment", "stripe", "checkout", "billing", "subscription", "in-app purchase"],
    searchTerms: ["Stripe integration", "payment intent flow", "webhook verification", "subscription billing", "idempotent payment"],
    checklist: ["payment intent creation", "webhook signature verification", "idempotency", "refund handling", "PCI-safe token handling"],
  },
  {
    id: "analytics", label: "Analytics / telemetry", category: "analytics", reuseValue: "medium",
    triggers: ["analytics", "telemetry", "tracking", "metrics", "event logging", "observability"],
    searchTerms: ["event tracking", "batched analytics", "OpenTelemetry instrumentation", "metrics collection"],
    checklist: ["event batching", "offline buffering", "schema definition", "opt-out support"],
  },
  {
    id: "state-management", label: "State management", category: "ui", reuseValue: "medium", foundational: true,
    triggers: ["state management", "redux", "mvi", "viewmodel", "store", "state container"],
    searchTerms: ["unidirectional state", "state container", "reducer pattern", "state restoration"],
    checklist: ["single source of truth", "state restoration", "side-effect handling", "testability"],
  },
  {
    id: "realtime-collab", label: "Realtime collaboration", category: "sync", reuseValue: "high",
    // Derivational variants must be listed explicitly — stemming handles inflection
    // ("collaborates"), not derivation ("collaboration" vs "collaborative").
    narrows: ["offline-sync"],
    triggers: ["collaborative", "collaboration", "collaborate", "multiplayer", "co-editing", "presence", "shared cursor", "crdt"],
    searchTerms: ["CRDT implementation", "operational transformation", "presence awareness", "collaborative editing"],
    checklist: ["concurrent edit merge", "presence", "undo across peers", "reconnection recovery"],
    implies: ["websocket", "offline-sync"],
  },
  {
    id: "file-parsing", label: "File format parsing", category: "other", reuseValue: "high",
    triggers: ["parse pdf", "parse csv", "excel", "docx", "markdown parser", "file format"],
    searchTerms: ["PDF text extraction", "CSV parser streaming", "spreadsheet parser", "markdown AST parser"],
    checklist: ["streaming for large files", "malformed input handling", "encoding detection"],
  },
  {
    id: "validation", label: "Input validation", category: "other", reuseValue: "medium",
    triggers: ["validation", "schema", "sanitize input", "form validation"],
    searchTerms: ["schema validation", "form validation library", "input sanitization"],
    checklist: ["declarative schema", "error messages", "type coercion rules"],
  },
  {
    id: "i18n", label: "Internationalisation", category: "other", reuseValue: "medium",
    triggers: ["i18n", "localization", "localisation", "translation", "multi language", "rtl"],
    searchTerms: ["i18n library", "pluralization rules", "locale detection", "RTL layout support"],
    checklist: ["string catalogues", "pluralisation", "locale fallback", "date/number formatting"],
  },
  {
    id: "testing-infra", label: "Test infrastructure", category: "testing", reuseValue: "medium",
    triggers: ["test harness", "fixtures", "mocking", "e2e test", "test infrastructure"],
    searchTerms: ["test fixtures", "mock server", "integration test harness", "snapshot testing"],
    checklist: ["fixture management", "isolation between tests", "deterministic runs"],
  },
];

/**
 * Per-stack idioms.
 *
 * The same capability has a completely different vocabulary per stack: background work is
 * "WorkManager" on Android, "BGTaskScheduler" on iOS, "BullMQ" on Node, "Celery" in Python.
 * Searching for the generic term finds tutorials; searching for the idiom finds
 * implementations.
 */
export interface StackIdioms {
  /** Matched against language/framework/platform, case-insensitively. */
  match: string[];
  language?: string;
  /** capability id -> idiomatic search terms for this stack. */
  idioms: Record<string, string[]>;
  /** Terms that identify this stack in a repository's metadata. */
  markers: string[];
}

export const STACK_IDIOMS: StackIdioms[] = [
  {
    match: ["android", "kotlin", "jetpack"], language: "Kotlin",
    markers: ["android", "kotlin", "jetpack", "compose", "gradle"],
    idioms: {
      "background-execution": ["WorkManager", "ForegroundService", "JobScheduler", "CoroutineWorker"],
      // (queue idioms are defined below and deliberately overlap: on Android the durable
      // queue and the background runner are frequently the same library.)
      "http-client": ["OkHttp", "Retrofit", "Ktor client"],
      persistence: ["Room database", "DataStore", "SQLDelight"],
      "secure-storage": ["EncryptedSharedPreferences", "Android Keystore"],
      "image-loading": ["Coil", "Glide", "Picasso"],
      "media-playback": ["ExoPlayer", "Media3"],
      "state-management": ["ViewModel StateFlow", "MVI Android"],
      notifications: ["NotificationCompat", "Firebase Cloud Messaging Android"],
      // "WorkManager" alone matters: it is THE Android answer for a durable job queue, and
      // a library implementing one says so in its description. Borrowing the query from the
      // background-execution capability instead would reintroduce cross-capability query
      // leakage — the same mechanism that sent "Room database" out for a resumable-transfer
      // search. Vocabulary belongs to the capability it describes.
      queue: ["WorkManager", "WorkManager chained work", "Room-backed queue", "persistent work queue Android"],
      "file-storage": ["Storage Access Framework", "MediaStore", "scoped storage"],
      download: ["DownloadManager Android", "OkHttp download"],
    },
  },
  {
    match: ["ios", "swift", "swiftui", "objective-c"], language: "Swift",
    markers: ["ios", "swift", "swiftui", "xcode", "cocoapods"],
    idioms: {
      "background-execution": ["BGTaskScheduler", "URLSession background session"],
      "http-client": ["URLSession", "Alamofire"],
      persistence: ["Core Data", "GRDB", "SwiftData"],
      "secure-storage": ["Keychain Services", "KeychainAccess"],
      "image-loading": ["Kingfisher", "SDWebImage", "AsyncImage"],
      "media-playback": ["AVPlayer", "AVFoundation"],
      "state-management": ["Combine ObservableObject", "TCA Composable Architecture"],
      notifications: ["UNUserNotificationCenter", "APNs"],
      download: ["URLSession downloadTask", "background URLSession"],
      resume: ["URLSessionDownloadTask resumeData"],
    },
  },
  {
    match: ["react", "next", "nextjs", "next.js", "typescript", "javascript", "node"], language: "TypeScript",
    markers: ["react", "next", "typescript", "npm", "node"],
    idioms: {
      "background-execution": ["BullMQ", "Agenda", "node worker threads", "cron job node"],
      "http-client": ["axios wrapper", "fetch wrapper", "ky", "tRPC client"],
      persistence: ["Prisma", "Drizzle ORM", "TypeORM", "Knex"],
      "state-management": ["Zustand", "Redux Toolkit", "Jotai", "TanStack Query"],
      caching: ["TanStack Query cache", "Redis cache node", "lru-cache"],
      "auth-session": ["NextAuth", "Auth.js", "Lucia auth", "Passport.js"],
      oauth: ["NextAuth Google provider", "Auth.js OAuth", "openid-client"],
      websocket: ["Socket.IO", "ws reconnect", "Pusher channels"],
      queue: ["BullMQ", "pg-boss", "Redis queue node"],
      payments: ["Stripe node SDK", "stripe webhooks express"],
      feed: ["TanStack infinite query", "react-window virtual list"],
    },
  },
  {
    match: ["python", "django", "flask", "fastapi"], language: "Python",
    markers: ["python", "django", "flask", "fastapi", "pip"],
    idioms: {
      "background-execution": ["Celery worker", "RQ Redis Queue", "APScheduler", "Dramatiq"],
      "http-client": ["httpx client", "requests session", "aiohttp"],
      persistence: ["SQLAlchemy", "Django ORM", "Tortoise ORM", "alembic migration"],
      "auth-session": ["Django auth", "FastAPI OAuth2PasswordBearer", "Flask-Login"],
      queue: ["Celery task queue", "RQ", "Redis queue python"],
      caching: ["Redis cache python", "functools lru_cache", "django cache framework"],
      "search-indexing": ["Whoosh", "Elasticsearch python client", "pgvector search"],
      validation: ["Pydantic model", "marshmallow schema"],
    },
  },
  {
    match: ["flutter", "dart"], language: "Dart",
    markers: ["flutter", "dart", "pubspec"],
    idioms: {
      "background-execution": ["WorkManager flutter", "flutter_background_service", "isolate"],
      "http-client": ["dio", "http package dart"],
      persistence: ["sqflite", "Drift", "Hive", "Isar"],
      "state-management": ["Riverpod", "Bloc", "Provider"],
      "image-loading": ["cached_network_image"],
      download: ["flutter_downloader", "dio download"],
    },
  },
  {
    match: ["go", "golang"], language: "Go",
    markers: ["go", "golang", "go.mod"],
    idioms: {
      "background-execution": ["goroutine worker pool", "asynq", "machinery"],
      "http-client": ["net/http client", "resty"],
      persistence: ["sqlx", "GORM", "pgx", "ent"],
      queue: ["asynq redis queue", "NATS JetStream", "channel worker pool"],
      "rate-limiting": ["golang.org/x/time/rate", "tollbooth"],
    },
  },
  {
    match: ["rust"], language: "Rust",
    markers: ["rust", "cargo", "crates"],
    idioms: {
      "http-client": ["reqwest", "hyper client"],
      persistence: ["sqlx rust", "diesel", "sea-orm"],
      "background-execution": ["tokio task", "tokio worker"],
      queue: ["lapin amqp", "tokio mpsc queue"],
    },
  },
  {
    match: ["java", "spring", "springboot", "spring boot"], language: "Java",
    markers: ["java", "spring", "maven", "gradle"],
    idioms: {
      "background-execution": ["Spring @Async", "Quartz scheduler", "Spring Batch"],
      "http-client": ["OkHttp", "RestTemplate", "WebClient"],
      persistence: ["Spring Data JPA", "Hibernate", "jOOQ", "Flyway migration"],
      "auth-session": ["Spring Security", "JWT Spring Boot"],
      queue: ["Spring AMQP RabbitMQ", "Kafka consumer java"],
    },
  },
];

/** Find the idiom set matching a stack description, if any. */
export function findStackIdioms(...hints: (string | undefined)[]): StackIdioms | undefined {
  const hay = hints.filter(Boolean).join(" ").toLowerCase();
  if (!hay) return undefined;
  let best: { s: StackIdioms; score: number } | undefined;
  for (const s of STACK_IDIOMS) {
    const score = s.match.filter((m) => hay.includes(m)).length;
    if (score > 0 && (!best || score > best.score)) best = { s, score };
  }
  return best?.s;
}

export const CAPABILITY_BY_ID = new Map(CAPABILITIES.map((c) => [c.id, c]));
