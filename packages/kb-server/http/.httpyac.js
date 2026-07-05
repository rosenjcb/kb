/** httpyac env for `server.http` and `slack.http`. `http/package.json` sets type=commonjs (root repo is ESM). */
module.exports = {
  environments: {
    $shared: {
      apiKey: 'testkey',
      // Must match SLACK_SIGNING_SECRET the server was started with (used by slack.http).
      slackSigningSecret: 'test-signing-secret',
    },
    local: {
      baseUrl: 'http://localhost:38117',
    },
    docker: {
      baseUrl: 'http://localhost:38117',
    },
    prod: {
      baseUrl: 'https://kb-y47gkpkfuq-uc.a.run.app',
    },
  },
}
