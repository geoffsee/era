import { randomUUID } from "node:crypto";
import {
    chmodSync,
    closeSync,
    existsSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type SavedCredential = {
    apiToken: string;
    keyId: string;
    repository: string;
    subject: string;
    expiresAt: number;
};
export type CredentialState = {
    version: 1;
    activeApi?: string;
    activeRepository: Record<string, string>;
    credentials: Record<string, SavedCredential>;
};
export interface CredentialCache {
    read(): CredentialState;
    write(state: CredentialState): void;
}
export const emptyCredentials = (): CredentialState => ({ version: 1, activeRepository: {}, credentials: {} });
export const credentialId = (api: string, repository: string) => JSON.stringify([api, repository.toLowerCase()]);

export class MemoryCredentialCache implements CredentialCache {
    private state = emptyCredentials();
    read(): CredentialState {
        return structuredClone(this.state);
    }
    write(state: CredentialState): void {
        this.state = structuredClone(state);
    }
}
export class FileCredentialCache implements CredentialCache {
    constructor(
        readonly path: string = join(
            process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
            "era",
            "credentials.json",
        ),
    ) {}
    read(): CredentialState {
        if (!existsSync(this.path)) return emptyCredentials();
        if (lstatSync(this.path).isSymbolicLink()) throw new Error("ERA credential file must not be a symbolic link");
        const state = JSON.parse(readFileSync(this.path, "utf8")) as CredentialState;
        if (state.version !== 1 || !state.credentials || !state.activeRepository)
            throw new Error("Unsupported ERA credential file; credentials were preserved");
        return state;
    }
    write(state: CredentialState): void {
        const directory = dirname(this.path);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        if (lstatSync(directory).isSymbolicLink() || (existsSync(this.path) && lstatSync(this.path).isSymbolicLink()))
            throw new Error("ERA credential path must not be a symbolic link");
        chmodSync(directory, 0o700);
        const temporary = `${this.path}.${randomUUID()}.tmp`;
        const descriptor = openSync(temporary, "wx", 0o600);
        try {
            try {
                writeFileSync(descriptor, `${JSON.stringify(state)}\n`);
            } finally {
                closeSync(descriptor);
            }
            renameSync(temporary, this.path);
        } finally {
            if (existsSync(temporary)) unlinkSync(temporary);
        }
    }
}
