/** Indexes of `task` in `text`. The scan does not parse the conversation. */
export function taskIndexes(text: string, task: string): number[] {
    if (task.length === 0) {
        return [];
    }
    const pattern = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(task)}(?![A-Za-z0-9])`, "g");
    const indexes: number[] = [];
    for (const match of text.matchAll(pattern)) {
        if (match.index !== undefined) {
            indexes.push(match.index);
        }
    }
    return indexes;
}

export interface TaskCandidate {
    id: string;
    indexes: readonly number[];
}

/**
 * The session whose first match is nearest the start of the text.
 * An equal first index uses the larger quantity of indexes.
 */
export function selectTaskCandidate(agent: string, task: string, candidates: readonly TaskCandidate[]): string {
    const hits = candidates.filter((candidate) => candidate.indexes.length > 0);
    if (hits.length === 0) {
        throw new TaskMiss(agent, task);
    }
    const ranked = [...hits].sort((left, right) => {
        const position = left.indexes[0]! - right.indexes[0]!;
        if (position !== 0) {
            return position;
        }
        return right.indexes.length - left.indexes.length;
    });
    const best = ranked[0]!;
    const tied = ranked.filter(
        (candidate) => candidate.indexes[0] === best.indexes[0] && candidate.indexes.length === best.indexes.length,
    );
    if (tied.length > 1) {
        throw new Error(
            `multiple ${agent} sessions for task "${task}": ${tied
                .map((candidate) => candidate.id)
                .sort()
                .join(", ")}`,
        );
    }
    return best.id;
}

export function selectByTask<T extends { id: string }>(
    agent: string,
    found: readonly T[],
    task: string,
    textOf: (item: T) => string,
): T {
    const id = selectTaskCandidate(
        agent,
        task,
        found.map((item) => ({ id: item.id, indexes: taskIndexes(textOf(item), task) })),
    );
    const match = found.find((item) => item.id === id);
    if (match === undefined) {
        throw new TaskMiss(agent, task);
    }
    return match;
}

/** No session text contained the task identifier. */
export class TaskMiss extends Error {
    constructor(agent: string, task: string) {
        super(`no ${agent} session contains task "${task}"`);
        this.name = "TaskMiss";
    }
}

function escapeRegExp(value: string): string {
    return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}
