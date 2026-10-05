import type {
    ApiKeyCredential,
    CredentialStore,
    SessionRecord,
    SessionStore,
    StateEntry,
    StateStore,
} from "@di-framework/auth";
import type { SqlDatabase } from "../tracking/ledger.ts";

export type Grant = { repository: string; repositoryId: number; installationId: number };
export type RepositoryKey = ApiKeyCredential & Grant;

/** Durable records; compare-and-swap and consume are single SQL statements across Worker isolates. */
export class AuthStore {
    constructor(
        readonly db: SqlDatabase,
        readonly now: () => number = () => Math.floor(Date.now() / 1000),
    ) {}

    async get<T>(kind: string, id: string): Promise<T | null> {
        const rows = await this.db
            .prepare("SELECT value FROM auth_records WHERE kind=?1 AND id=?2")
            .bind(kind, id)
            .all<{ value: string }>();
        return rows.results[0] ? (JSON.parse(rows.results[0].value) as T) : null;
    }
    async put(kind: string, id: string, value: unknown, expiresAt = 0): Promise<void> {
        await this.db
            .prepare(
                "INSERT INTO auth_records(kind,id,value,expires_at) VALUES(?1,?2,?3,?4) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at",
            )
            .bind(kind, id, JSON.stringify(value), expiresAt)
            .run();
    }
    async replace(kind: string, id: string, before: unknown, after: unknown): Promise<boolean> {
        const rows = await this.db
            .prepare("UPDATE auth_records SET value=?4 WHERE kind=?1 AND id=?2 AND value=?3 RETURNING id")
            .bind(kind, id, JSON.stringify(before), JSON.stringify(after))
            .all<{ id: string }>();
        return rows.results.length === 1;
    }
    async remove(kind: string, id: string): Promise<boolean> {
        const rows = await this.db
            .prepare("DELETE FROM auth_records WHERE kind=?1 AND id=?2 RETURNING id")
            .bind(kind, id)
            .all<{ id: string }>();
        return rows.results.length === 1;
    }
    async consume<T>(kind: string, id: string, approvedOnly = false): Promise<T | null> {
        const rows = await this.db
            .prepare(
                `DELETE FROM auth_records WHERE kind=?1 AND id=?2 AND expires_at>?3 ${approvedOnly ? "AND json_extract(value,'$.status')='approved'" : ""} RETURNING value`,
            )
            .bind(kind, id, this.now())
            .all<{ value: string }>();
        return rows.results[0] ? (JSON.parse(rows.results[0].value) as T) : null;
    }
    async listKeys(userId: string, cursor = ""): Promise<RepositoryKey[]> {
        const rows = await this.db
            .prepare(
                "SELECT value FROM auth_records WHERE kind='key' AND json_extract(value,'$.userId')=?1 AND id>?2 ORDER BY id LIMIT 101",
            )
            .bind(userId, cursor)
            .all<{ value: string }>();
        return rows.results.map((row) => JSON.parse(row.value) as RepositoryKey);
    }
    async revokeKeys(userId: string, repositoryId?: number): Promise<void> {
        await this.db
            .prepare(
                `UPDATE auth_records SET value=json_set(value,'$.disabled',json('true')) WHERE kind='key' AND json_extract(value,'$.userId')=?1 ${repositoryId === undefined ? "" : "AND json_extract(value,'$.repositoryId')=?2"}`,
            )
            .bind(...(repositoryId === undefined ? [userId] : [userId, repositoryId]))
            .run();
    }
    async purge(): Promise<void> {
        await this.db
            .prepare(
                "DELETE FROM auth_records WHERE kind IN ('state','session','flow','code','permission','throttle') AND expires_at<=?1",
            )
            .bind(this.now())
            .run();
    }
    async throttle(id: string, limit: number, windowSeconds: number): Promise<boolean> {
        const bucket = `${id}:${Math.floor(this.now() / windowSeconds)}`;
        const rows = await this.db
            .prepare(
                "INSERT INTO auth_records(kind,id,value,expires_at) VALUES('throttle',?1,'1',?2) ON CONFLICT(kind,id) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) RETURNING value",
            )
            .bind(bucket, this.now() + windowSeconds)
            .all<{ value: string }>();
        return Number(rows.results[0]?.value) <= limit;
    }
    state(): StateStore {
        return {
            put: (entry) => this.put("state", `${entry.purpose}:${entry.key}`, entry, entry.expiresAt),
            consume: <T>(purpose: string, key: string) => this.consume<StateEntry<T>>("state", `${purpose}:${key}`),
        };
    }
    sessions(): SessionStore {
        return {
            get: (id) => this.get<SessionRecord>("session", id),
            create: async (session) => {
                await this.put("session", session.id, session, session.absoluteExpiresAt);
                return session;
            },
            touch: async (id, at) => {
                await this.db
                    .prepare(
                        "UPDATE auth_records SET value=json_set(value,'$.lastSeenAt',?2) WHERE kind='session' AND id=?1",
                    )
                    .bind(id, at)
                    .run();
            },
            delete: (id) => this.remove("session", id),
            deleteBySubject: async (subject) => {
                const rows = await this.db
                    .prepare(
                        "DELETE FROM auth_records WHERE kind='session' AND json_extract(value,'$.subject')=?1 RETURNING id",
                    )
                    .bind(subject)
                    .all<{ id: string }>();
                return rows.results.length;
            },
        };
    }
    credentials(grant?: Grant): CredentialStore {
        const unsupported = async (): Promise<never> => {
            throw new Error("Password and WebAuthn credentials are not enabled");
        };
        return {
            findPassword: unsupported,
            savePassword: unsupported,
            deletePassword: unsupported,
            findWebAuthn: unsupported,
            listWebAuthn: unsupported,
            saveWebAuthn: unsupported,
            deleteWebAuthn: unsupported,
            updateSignCount: unsupported,
            findApiKey: (id) => this.get<RepositoryKey>("key", id),
            listApiKeys: async (userId) => {
                const result: RepositoryKey[] = [];
                let cursor = "";
                for (;;) {
                    const page = await this.listKeys(userId, cursor);
                    result.push(...page.slice(0, 100));
                    if (page.length <= 100) return result;
                    cursor = page[99]!.id;
                }
            },
            saveApiKey: async (credential) => {
                const existing = await this.get<RepositoryKey>("key", credential.id);
                const scope = grant ?? existing;
                if (!scope) throw new Error("Repository grant is required");
                await this.put("key", credential.id, { ...scope, ...credential }, credential.expiresAt ?? 0);
                return credential;
            },
            deleteApiKey: (id) => this.remove("key", id),
        };
    }
}
