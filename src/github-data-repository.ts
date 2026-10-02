type Issue = any;

interface IGitHubDataRepository {
    getIssues(): Promise<Issue[]>;

}

class GitHubDataRepository implements IGitHubDataRepository {

}