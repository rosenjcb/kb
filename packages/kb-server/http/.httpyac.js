/** httpyac env for `server.http` and `slack.http`. `http/package.json` sets type=commonjs (root repo is ESM). */
module.exports = {
  environments: {
    $shared: {
      apiKey: 'testkey',
      // Must match SLACK_SIGNING_SECRET the server was started with (used by slack.http).
      slackSigningSecret: 'test-signing-secret',
    },
    local: {
      baseUrl: 'http://localhost:8080',
    },
    docker: {
      baseUrl: 'http://localhost:8080',
    },
    prod: {
      baseUrl: 'https://kb-server-REPLACE.run.app',
    },
  },
}
