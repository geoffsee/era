import { Octokit, App } from "octokit";

// Create a personal access token at https://github.com/settings/tokens/new?scopes=repo
const githubClient = new Octokit({ auth: `personal-access-token123` });

// Compare: https://docs.github.com/en/rest/reference/users#get-the-authenticated-user
const {
    data: { login },
} = await githubClient.rest.users.getAuthenticated();
console.log("Logged in as: %s", login);


export default githubClient;