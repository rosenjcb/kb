/** httpyac env for `slack.http`. `http/package.json` sets type=commonjs (root repo is ESM). */
module.exports = {
  environments: {
    $shared: {
      // Must match the SLACK_SIGNING_SECRET the bot was started with.
      slackSigningSecret: 'test-signing-secret',
    },
    local: {
      slackBaseUrl: 'http://localhost:3000',
    },
    docker: {
      slackBaseUrl: 'http://localhost:3000',
    },
  },
}
