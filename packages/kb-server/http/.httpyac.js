/** httpyac env for `server.http`. `http/package.json` sets type=commonjs (root repo is ESM). */
module.exports = {
  environments: {
    $shared: {
      apiKey: 'testkey',
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
