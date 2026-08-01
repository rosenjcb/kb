import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  listEcosystemIds,
  loadInfraEcosystemConfig,
  loadTypescriptEcosystemConfig,
} from '@kb/core/tools/ecosystem-config.js'
import {
  classifyPackageKind,
  harvestAppConcepts,
  harvestContractManifests,
  harvestCppEcosystem,
  harvestCsharpEcosystem,
  harvestGoEcosystem,
  harvestHaskellEcosystem,
  harvestInfraManifests,
  harvestJavaEcosystem,
  harvestPhpEcosystem,
  harvestPythonEcosystem,
  harvestRepoEntities,
  harvestRouteDecorators,
  harvestRubyEcosystem,
  harvestRustEcosystem,
  harvestScalaEcosystem,
  harvestTypeScriptEcosystem,
} from '@kb/core/tools/ecosystem-harvesters.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

let scanDir: string

beforeEach(async () => {
  scanDir = await mkdtemp(path.join(os.tmpdir(), 'kb-harvester-'))
})

afterEach(async () => {
  await rm(scanDir, { recursive: true, force: true })
})

async function writePackage(dir: string, pkg: Record<string, unknown>): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg))
}

describe('ecosystem YAML configs', () => {
  it('[TC-1] Given typescript.yaml, when loaded, then frameworks, kind_rules, and symbol/route gaps are present', () => {
    const ts = loadTypescriptEcosystemConfig()
    expect(ts.id).toBe('typescript')
    expect(ts.frameworks.server).toContain('express')
    expect(ts.frameworks.frontend).toContain('react')
    expect(ts.frameworks.cli).toContain('commander')
    expect(ts.kind_rules.length).toBeGreaterThanOrEqual(5)
    expect(ts.symbols.status).toBe('partial')
    expect(ts.routes.status).toBe('partial')
  })

  it('[TC-2] Given infra.yaml, when loaded, then compose, fly, Backstage, k8s, helm, procfile configured', () => {
    const infra = loadInfraEcosystemConfig()
    expect(infra.id).toBe('infra')
    expect(infra.compose.files).toContain('docker-compose.yml')
    expect(infra.fly.file).toBe('fly.toml')
    expect(infra.backstage.file).toBe('catalog-info.yaml')
    expect(infra.kubernetes.dirs).toContain('k8s')
    expect(infra.kubernetes.kinds).toContain('Deployment')
    expect(infra.helm.file).toBe('Chart.yaml')
    expect(infra.procfile.file).toBe('Procfile')
  })

  it('[TC-9] Given typescript coverage sections, when inspected, then symbols and routes are partial', () => {
    const ts = loadTypescriptEcosystemConfig()
    expect(ts.symbols.status).toBe('partial')
    expect(ts.routes.status).toBe('partial')
  })

  it('[TC-10] Given all LANG ecosystems, when listed, then YAML coverage files exist for each', () => {
    const ids = listEcosystemIds()
    for (const id of [
      'typescript',
      'go',
      'python',
      'rust',
      'ruby',
      'java',
      'csharp',
      'php',
      'scala',
      'haskell',
      'cpp',
      'css',
      'html',
      'bash',
      'infra',
    ]) {
      expect(ids).toContain(id)
    }
  })
})

describe('classifyPackageKind', () => {
  it('[TC-3] Given package.json features, when classified, then YAML kind rubric maps to service/cli/surface/library', () => {
    expect(classifyPackageKind({ dependencies: { express: '4' } }).kind).toBe('service')
    expect(classifyPackageKind({ bin: { kb: './bin/kb' } }).kind).toBe('cli')
    expect(
      classifyPackageKind({ name: '@kb/server', bin: { 'kb-server': './dist/bin/kb-server' } }).kind
    ).toBe('service')
    expect(classifyPackageKind({ dependencies: { react: '18' } }).kind).toBe('surface')
    expect(classifyPackageKind({ main: 'index.js' }).kind).toBe('library')
    expect(classifyPackageKind({}).confidence).toBeLessThan(0.5)
  })
})

describe('harvestTypeScriptEcosystem', () => {
  it('[TC-4] Given a pnpm workspace, when harvested, then packages get identity, aliases, kinds, and part_of edges', async () => {
    await writeFile(path.join(scanDir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
    await writePackage(scanDir, { name: 'acme-monorepo', private: true })
    await writePackage(path.join(scanDir, 'packages', 'client'), {
      name: '@acme/client',
      description: 'Terminal client',
      bin: { acme: './bin/acme' },
    })
    await writePackage(path.join(scanDir, 'packages', 'server'), {
      name: '@acme/server',
      description: 'API daemon',
      dependencies: { express: '^4.0.0' },
      scripts: { start: 'node dist/server.js' },
    })
    await writePackage(path.join(scanDir, 'packages', 'core'), {
      name: '@acme/core',
      main: 'dist/index.js',
    })

    const result = await harvestTypeScriptEcosystem(scanDir)
    const byName = new Map(result.candidates.map(c => [c.canonicalName, c]))

    expect(byName.get('@acme/client')?.kind).toBe('cli')
    expect(byName.get('@acme/client')?.aliases).toContain('acme')
    expect(byName.get('@acme/client')?.aliases).toContain('client')
    expect(byName.get('@acme/server')?.kind).toBe('service')
    expect(byName.get('@acme/server')?.gloss).toBe('API daemon')
    expect(byName.get('@acme/core')?.kind).toBe('library')

    // Workspace membership edges point at the root package.
    expect(result.edges).toContainEqual({
      fromName: '@acme/server',
      toName: 'acme-monorepo',
      edgeType: 'part_of',
    })
  })

  it('[TC-5] Given a solo package or empty dir, when harvested, then root-only or zero candidates', async () => {
    await writePackage(scanDir, { name: 'solo-svc', dependencies: { fastify: '4' } })
    const single = await harvestTypeScriptEcosystem(scanDir)
    expect(single.candidates).toHaveLength(1)
    expect(single.candidates[0]?.canonicalName).toBe('solo-svc')
    expect(single.candidates[0]?.kind).toBe('service')

    const emptyDir = await mkdtemp(path.join(os.tmpdir(), 'kb-harvester-empty-'))
    try {
      const empty = await harvestTypeScriptEcosystem(emptyDir)
      expect(empty.candidates).toHaveLength(0)
    } finally {
      await rm(emptyDir, { recursive: true, force: true })
    }
  })
})

describe('harvestInfraManifests', () => {
  it('[TC-6] Given compose, fly, and Backstage manifests, when harvested, then service/app/catalog candidates and belongs_to', async () => {
    await writeFile(
      path.join(scanDir, 'docker-compose.yml'),
      [
        'services:',
        '  payments-svc:',
        '    image: acme/payments',
        '  internal:',
        '    image: acme/internal',
      ].join('\n')
    )
    await writeFile(path.join(scanDir, 'fly.toml'), 'app = "acme-edge"\n[env]\n')
    await writeFile(
      path.join(scanDir, 'catalog-info.yaml'),
      [
        'apiVersion: backstage.io/v1alpha1',
        'kind: Component',
        'metadata:',
        '  name: payments',
        '  description: Payments domain service',
        'spec:',
        '  type: service',
        '  domain: commerce',
      ].join('\n')
    )

    const result = await harvestInfraManifests(scanDir)
    const names = result.candidates.map(c => c.canonicalName).sort()
    expect(names).toEqual(['acme-edge', 'internal', 'payments', 'payments-svc'])
    expect(result.candidates.every(c => c.sourceKind === 'manifest')).toBe(true)
    expect(result.edges).toContainEqual({
      fromName: 'payments',
      toName: 'commerce',
      edgeType: 'belongs_to',
    })
  })

  it('[TC-7] Given malformed compose YAML, when harvested, then zero candidates', async () => {
    await writeFile(path.join(scanDir, 'docker-compose.yml'), '{{ not yaml')
    const result = await harvestInfraManifests(scanDir)
    expect(result.candidates).toHaveLength(0)
  })

  it('[TC-21] Given k8s Deployment/Ingress, Helm Chart, Procfile, when harvested, then service/api candidates', async () => {
    await mkdir(path.join(scanDir, 'k8s'), { recursive: true })
    await writeFile(
      path.join(scanDir, 'k8s', 'deploy.yaml'),
      [
        'apiVersion: apps/v1',
        'kind: Deployment',
        'metadata:',
        '  name: payments-api',
        'spec:',
        '  replicas: 2',
        '---',
        'apiVersion: v1',
        'kind: Service',
        'metadata:',
        '  name: payments-api',
        '---',
        'apiVersion: networking.k8s.io/v1',
        'kind: Ingress',
        'metadata:',
        '  name: payments-ingress',
      ].join('\n')
    )
    await writeFile(
      path.join(scanDir, 'k8s', 'templated.yaml'),
      ['kind: Deployment', 'metadata:', '  name: {{ .Values.name }}'].join('\n')
    )
    await mkdir(path.join(scanDir, 'charts', 'billing'), { recursive: true })
    await writeFile(
      path.join(scanDir, 'charts', 'billing', 'Chart.yaml'),
      ['apiVersion: v2', 'name: billing-chart', 'version: 0.1.0'].join('\n')
    )
    await writeFile(
      path.join(scanDir, 'Procfile'),
      ['web: node server.js', 'worker: node worker.js', '# comment'].join('\n')
    )

    const result = await harvestInfraManifests(scanDir)
    const byName = new Map(result.candidates.map(c => [c.canonicalName, c]))

    expect(byName.get('payments-api')?.kind).toBe('service')
    expect(byName.get('payments-ingress')?.kind).toBe('api')
    expect(byName.get('billing-chart')?.kind).toBe('service')
    expect(byName.has('{{ .Values.name }}')).toBe(false)

    const proc = byName.get(path.basename(scanDir))
    expect(proc?.kind).toBe('service')
    expect(proc?.aliases).toEqual(expect.arrayContaining(['web', 'worker']))
  })
})

describe('harvestContractManifests', () => {
  it('[TC-22] Given OpenAPI + protobuf service, when harvested, then api candidates', async () => {
    await writeFile(
      path.join(scanDir, 'openapi.yaml'),
      ['openapi: 3.0.3', 'info:', '  title: Payments API', '  version: 1.0.0', 'paths: {}'].join(
        '\n'
      )
    )
    await mkdir(path.join(scanDir, 'proto'), { recursive: true })
    await writeFile(
      path.join(scanDir, 'proto', 'billing.proto'),
      [
        'syntax = "proto3";',
        'package acme.billing;',
        'service BillingService {',
        '  rpc Charge (ChargeRequest) returns (ChargeReply);',
        '}',
      ].join('\n')
    )

    await writeFile(
      path.join(scanDir, 'openapi-paths.yaml'),
      [
        'openapi: 3.0.3',
        'info:',
        '  title: Catalog API',
        '  version: 1.0.0',
        'paths:',
        '  /v1/items:',
        '    get:',
        '      summary: List items',
        '    post:',
        '      summary: Create item',
        '  /v1/items/{id}:',
        '    delete:',
        '      summary: Delete item',
      ].join('\n')
    )

    const result = await harvestContractManifests(scanDir)
    const byName = new Map(result.candidates.map(c => [c.canonicalName, c]))
    expect(byName.get('Payments API')?.kind).toBe('api')
    expect(byName.get('Payments API')?.confidence).toBeGreaterThanOrEqual(0.85)
    expect(byName.get('acme.billing.BillingService')?.kind).toBe('api')
    expect(byName.get('acme.billing.BillingService')?.aliases).toContain('BillingService')
    expect(byName.get('Catalog API')?.kind).toBe('api')
    expect(byName.get('/v1/items')?.kind).toBe('api')
    expect(byName.get('GET /v1/items')?.kind).toBe('api')
    expect(byName.get('POST /v1/items')?.kind).toBe('api')
    expect(byName.get('DELETE /v1/items/{id}')?.kind).toBe('api')
  })
})

describe('harvestRouteDecorators', () => {
  it('[TC-23] Given multi-language routes, when harvested, then api/surface candidates; noise skipped', async () => {
    await mkdir(path.join(scanDir, 'src'), { recursive: true })
    await writeFile(
      path.join(scanDir, 'src', 'payments.controller.ts'),
      [
        "import { Controller, Get } from '@nestjs/common'",
        "@Controller('payments')",
        'export class PaymentsController {}',
        "app.get('/health', handler)",
        "router.post('/v1/charge', charge)",
      ].join('\n')
    )
    await writeFile(
      path.join(scanDir, 'src', 'main.py'),
      [
        'from fastapi import FastAPI',
        'app = FastAPI()',
        '@app.get("/items")',
        'def list_items(): ...',
        '@bp.route("/flask-health")',
        'urlpatterns = [path("admin/", admin.site.urls)]',
        'path("mitmproxy/data/foo.pem")', // false-positive shape — filter out
      ].join('\n')
    )
    await writeFile(
      path.join(scanDir, 'src', 'server.go'),
      [
        'package main',
        'func main() {',
        '  r.GET("/ping", ping)',
        '  http.HandleFunc("/ready", ready)',
        '}',
      ].join('\n')
    )
    await mkdir(path.join(scanDir, 'src', 'main', 'java', 'com', 'acme'), { recursive: true })
    await writeFile(
      path.join(scanDir, 'src', 'main', 'java', 'com', 'acme', 'BillingController.java'),
      [
        'package com.acme;',
        '@RestController',
        '@RequestMapping("/api/billing")',
        'class BillingController {',
        '  @GetMapping("/invoices")',
        '  Invoice list() { return null; }',
        '  @PostMapping(path = "/invoices")',
        '  Invoice create() { return null; }',
        '  @RequestMapping(method = RequestMethod.DELETE, value = "/invoices/{id}")',
        '  void delete() {}',
        '}',
      ].join('\n')
    )
    await writeFile(
      path.join(scanDir, 'src', 'Program.cs'),
      [
        '[Route("api/[controller]")]',
        'public class OrdersController {',
        '  [HttpGet("open")] public void Open() {}',
        '}',
        'app.MapGet("/dotnet-health", () => "ok");',
      ].join('\n')
    )
    await writeFile(
      path.join(scanDir, 'src', 'web.php'),
      [
        "Route::get('/laravel-up', fn () => 'ok');",
        "#[Route('/symfony-ping')]",
        'class Ping {}',
      ].join('\n')
    )
    await writeFile(
      path.join(scanDir, 'src', 'routes.rs'),
      [
        'fn routes() { Router::new().route("/axum-up", get(handler)); }',
        '#[get("/rocket-up")]',
        'async fn rocket_up() {}',
      ].join('\n')
    )
    await writeFile(
      path.join(scanDir, 'src', 'Api.hs'),
      'type API = "users" :> Get \'[JSON] [User]\n'
    )
    await writeFile(
      path.join(scanDir, 'src', 'server.cpp'),
      'CROW_ROUTE(app, "/crow-up")([](){ return "ok"; });\n'
    )
    await mkdir(path.join(scanDir, 'conf'), { recursive: true })
    await writeFile(
      path.join(scanDir, 'conf', 'routes'),
      'GET /play-up controllers.HealthController.up\n'
    )
    await mkdir(path.join(scanDir, 'app', 'api', 'hello'), { recursive: true })
    await writeFile(
      path.join(scanDir, 'app', 'api', 'hello', 'route.ts'),
      'export async function GET() {}'
    )
    await mkdir(path.join(scanDir, 'app', '(marketing)', 'about'), { recursive: true })
    await writeFile(
      path.join(scanDir, 'app', '(marketing)', 'about', 'page.tsx'),
      'export default function About() {}'
    )
    await mkdir(path.join(scanDir, 'pages', 'api'), { recursive: true })
    await writeFile(
      path.join(scanDir, 'pages', 'api', 'health.ts'),
      'export default function handler() {}'
    )
    await mkdir(path.join(scanDir, 'config'), { recursive: true })
    await writeFile(
      path.join(scanDir, 'config', 'routes.rb'),
      [
        'Rails.application.routes.draw do',
        "  get 'uptime'",
        "  post '/webhooks/stripe'",
        '  resources :invoices',
        'end',
      ].join('\n')
    )
    // Should be skipped
    await mkdir(path.join(scanDir, 'node_modules', 'lib'), { recursive: true })
    await writeFile(
      path.join(scanDir, 'node_modules', 'lib', 'skip.ts'),
      "app.get('/should-not-appear', x)"
    )

    const result = await harvestRouteDecorators(scanDir)
    const names = result.candidates.map(c => c.canonicalName)
    const about = result.candidates.find(c => c.canonicalName === '/about')
    expect(names).toContain('payments')
    expect(names).toContain('GET /health')
    expect(names).toContain('POST /v1/charge')
    expect(names).toContain('GET /items')
    expect(names).toContain('/flask-health')
    expect(names).toContain('admin/')
    expect(names).toContain('GET /ping')
    expect(names).toContain('/ready')
    expect(names).toContain('/api/billing')
    expect(names).toContain('GET /api/billing/invoices')
    expect(names).toContain('POST /api/billing/invoices')
    expect(names).toContain('DELETE /api/billing/invoices/{id}')
    expect(names).toContain('api/[controller]')
    expect(names).toContain('GET open')
    expect(names).toContain('GET /dotnet-health')
    expect(names).toContain('GET /laravel-up')
    expect(names).toContain('/symfony-ping')
    expect(names).toContain('/axum-up')
    expect(names).toContain('/rocket-up')
    expect(names).toContain('GET /users')
    expect(names).toContain('/crow-up')
    expect(names).toContain('GET /play-up')
    expect(names).toContain('/api/hello')
    expect(names).toContain('/about')
    expect(about?.kind).toBe('surface')
    expect(names).toContain('/api/health')
    expect(names).toContain('/uptime')
    expect(names).toContain('/webhooks/stripe')
    expect(names).toContain('/invoices')
    expect(names).toContain('GET /invoices')
    expect(names).toContain('POST /invoices')
    expect(names).toContain('GET /invoices/:id')
    expect(names).toContain('PUT /invoices/:id')
    expect(names).toContain('PATCH /invoices/:id')
    expect(names).toContain('DELETE /invoices/:id')
    expect(names).not.toContain('GET /should-not-appear')
    expect(names).not.toContain('mitmproxy/data/foo.pem')
    expect(result.candidates.every(c => c.kind === 'api' || c.kind === 'surface')).toBe(true)
    expect(result.candidates.every(c => c.confidence === 0.5)).toBe(true)
  })
})

describe('harvestAppConcepts', () => {
  it('[TC-24] Given Spring/Nest/Django/Prisma/.NET/Rails app + DB types, when harvested, then module and model kinds', async () => {
    await mkdir(path.join(scanDir, 'src'), { recursive: true })
    await writeFile(
      path.join(scanDir, 'src', 'BillingService.java'),
      [
        'package com.acme;',
        '@Service',
        'public class BillingService {}',
        '@Entity',
        'public class Invoice {}',
        '@Table(name = "invoices")',
        'class Ignored {}',
      ].join('\n')
    )
    await writeFile(
      path.join(scanDir, 'src', 'users.service.ts'),
      [
        "import { Injectable } from '@nestjs/common'",
        '@Injectable()',
        'export class UsersService {}',
        '@Entity("accounts")',
        'export class Account {}',
      ].join('\n')
    )
    await writeFile(
      path.join(scanDir, 'src', 'models.py'),
      [
        'from django.db import models',
        'class Customer(models.Model):',
        '    pass',
        'class OrderService:',
        '    pass',
      ].join('\n')
    )
    await writeFile(
      path.join(scanDir, 'schema.prisma'),
      ['model User {', '  id Int @id', '}', 'model Post {', '  id Int @id', '}'].join('\n')
    )
    await writeFile(
      path.join(scanDir, 'src', 'PaymentsController.cs'),
      [
        '[ApiController]',
        '[Route("api/[controller]")]',
        'public class PaymentsController {}',
        'public class LedgerService {}',
        'public class AppDbContext {',
        '  public DbSet<LedgerEntry> Entries { get; set; }',
        '}',
      ].join('\n')
    )
    await mkdir(path.join(scanDir, 'app', 'models'), { recursive: true })
    await writeFile(
      path.join(scanDir, 'app', 'models', 'user.rb'),
      'class User < ApplicationRecord\nend\n'
    )
    await writeFile(
      path.join(scanDir, 'src', 'schema.sql'),
      'CREATE TABLE IF NOT EXISTS payment_events (\n  id SERIAL PRIMARY KEY\n);\n'
    )

    const result = await harvestAppConcepts(scanDir)
    const byKind = (k: string) =>
      result.candidates.filter(c => c.kind === k).map(c => c.canonicalName)
    expect(byKind('module')).toEqual(
      expect.arrayContaining([
        'BillingService',
        'UsersService',
        'OrderService',
        'PaymentsController',
        'LedgerService',
      ])
    )
    expect(byKind('model')).toEqual(
      expect.arrayContaining([
        'Invoice',
        'invoices',
        'Account',
        'Customer',
        'User',
        'Post',
        'LedgerEntry',
        'payment_events',
      ])
    )
    expect(result.candidates.every(c => c.kind === 'module' || c.kind === 'model')).toBe(true)
    expect(result.candidates.every(c => c.kind !== 'service')).toBe(true)
  })

  it('[TC-25] Given Nest methods, Go 1.22 mux, Drizzle/Mongoose/Sequelize, GraphQL, Hono, EF ToTable, when harvested, then routes and models expand', async () => {
    await mkdir(path.join(scanDir, 'src'), { recursive: true })
    await writeFile(
      path.join(scanDir, 'src', 'orders.controller.ts'),
      [
        "@Controller('orders')",
        "export class OrdersController {",
        "  @Get(':id')",
        '  getOne() {}',
        "  @Post()",
        '  create() {}',
        '}',
        "hono.get('/hono-up', c => c.text('ok'))",
        "sequelize.define('Widget', {})",
        "mongoose.model('Gadget', schema)",
        "export const users = pgTable('users', {})",
      ].join('\n')
    )
    await writeFile(
      path.join(scanDir, 'src', 'mux.go'),
      [
        'package main',
        'func main() {',
        '  mux.Handle("GET /v2/ready", h)',
        '  mux.HandleFunc("POST /v2/charge", h)',
        '}',
      ].join('\n')
    )
    await writeFile(
      path.join(scanDir, 'src', 'Db.cs'),
      ['modelBuilder.Entity<Order>().ToTable("orders");'].join('\n')
    )
    await writeFile(
      path.join(scanDir, 'schema.graphql'),
      ['type Query { me: User }', 'type Mutation { createUser: User }', 'type User { id: ID! }'].join(
        '\n'
      )
    )
    await writeFile(
      path.join(scanDir, 'sinatra.rb'),
      ["get '/sinatra-up' do", "  'ok'", 'end'].join('\n')
    )

    const routes = await harvestRouteDecorators(scanDir)
    const names = routes.candidates.map(c => c.canonicalName)
    expect(names).toContain('orders')
    expect(names).toContain('GET /orders/:id')
    expect(names).toContain('POST /orders')
    expect(names).toContain('GET /hono-up')
    expect(names).toContain('GET /v2/ready')
    expect(names).toContain('POST /v2/charge')
    expect(names).toContain('/graphql/Query')
    expect(names).toContain('/graphql/Mutation')
    expect(names).toContain('/sinatra-up')

    const concepts = await harvestAppConcepts(scanDir)
    const models = concepts.candidates.filter(c => c.kind === 'model').map(c => c.canonicalName)
    expect(models).toEqual(expect.arrayContaining(['Widget', 'Gadget', 'users', 'orders', 'User']))
  })

  it('[TC-26] Given Round-3 Spring join, Rails CRUD, Flask MethodView, Django include, tRPC, Slim, Symfony YAML, Room, Hibernate XML, Persistent TH, when harvested, then routes and models expand', async () => {
    await mkdir(path.join(scanDir, 'src'), { recursive: true })
    await mkdir(path.join(scanDir, 'config', 'routes'), { recursive: true })
    await mkdir(path.join(scanDir, 'users'), { recursive: true })
    await mkdir(path.join(scanDir, 'resources'), { recursive: true })

    await writeFile(
      path.join(scanDir, 'src', 'ApiController.java'),
      [
        'package com.acme;',
        '@RestController',
        '@RequestMapping("/api")',
        'class ApiController {',
        '  @GetMapping("/users")',
        '  Object users() { return null; }',
        '}',
      ].join('\n')
    )
    await writeFile(
      path.join(scanDir, 'config', 'routes.rb'),
      ['Rails.application.routes.draw do', '  resources :accounts', '  resource :profile', 'end'].join(
        '\n'
      )
    )
    await writeFile(
      path.join(scanDir, 'src', 'views.py'),
      [
        'from flask.views import MethodView',
        'class UserAPI(MethodView):',
        '    def get(self): ...',
        "app.add_url_rule('/mv-users', view_func=UserAPI.as_view('users'))",
      ].join('\n')
    )
    await writeFile(
      path.join(scanDir, 'config', 'urls.py'),
      [
        'from django.urls import path, include',
        "urlpatterns = [path('api/', include('users.urls'))]",
      ].join('\n')
    )
    await writeFile(
      path.join(scanDir, 'users', 'urls.py'),
      [
        'from django.urls import path',
        'from . import views',
        "urlpatterns = [path('users/', views.list_users)]",
      ].join('\n')
    )
    await writeFile(
      path.join(scanDir, 'src', 'trpc.ts'),
      [
        'export const appRouter = router({',
        '  getUser: publicProcedure.query(async () => null),',
        '  createUser: publicProcedure.mutation(async () => null),',
        '})',
      ].join('\n')
    )
    await writeFile(
      path.join(scanDir, 'src', 'slim.php'),
      [
        "<?php",
        "$app->get('/slim-up', $h);",
        "$app->map(['GET', 'POST'], '/slim-items', $h);",
      ].join('\n')
    )
    await writeFile(
      path.join(scanDir, 'config', 'routes', 'api.yaml'),
      [
        'api_users:',
        '  path: /symfony/users',
        '  controller: App\\Controller\\UserController',
        '  methods: [GET, POST]',
      ].join('\n')
    )
    await writeFile(
      path.join(scanDir, 'src', 'UserEntity.kt'),
      [
        '@Entity(tableName = "room_users")',
        'data class RoomUser(',
        '  @PrimaryKey val id: Int',
        ')',
      ].join('\n')
    )
    await writeFile(
      path.join(scanDir, 'resources', 'User.hbm.xml'),
      [
        '<?xml version="1.0"?>',
        '<!DOCTYPE hibernate-mapping PUBLIC "-//Hibernate/Hibernate Mapping DTD//EN" "http://hibernate.org/dtd/hibernate-mapping.dtd">',
        '<hibernate-mapping>',
        '  <class name="com.acme.BillingAccount" table="billing_accounts">',
        '  </class>',
        '</hibernate-mapping>',
      ].join('\n')
    )
    await writeFile(
      path.join(scanDir, 'src', 'Models.hs'),
      [
        'share [mkPersist sqlSettings, mkMigrate "migrateAll"] [persistLowerCase|',
        'User',
        '    name Text',
        '    email Text',
        '    deriving Show',
        'BlogPost',
        '    title String',
        '    userId UserId',
        '|]',
      ].join('\n')
    )

    const routes = await harvestRouteDecorators(scanDir)
    const names = routes.candidates.map(c => c.canonicalName)
    expect(names).toContain('GET /api/users')
    expect(names).toContain('/accounts')
    expect(names).toContain('GET /accounts')
    expect(names).toContain('POST /accounts')
    expect(names).toContain('GET /accounts/:id')
    expect(names).toContain('DELETE /accounts/:id')
    expect(names).toContain('GET /profile')
    expect(names).toContain('/mv-users')
    expect(names).toContain('flask:UserAPI')
    expect(names).toContain('api/')
    expect(names).toContain('api/users/')
    expect(names).toContain('trpc/getUser')
    expect(names).toContain('trpc/createUser')
    expect(names).toContain('GET /slim-up')
    expect(names).toContain('GET /slim-items')
    expect(names).toContain('POST /slim-items')
    expect(names).toContain('GET /symfony/users')
    expect(names).toContain('POST /symfony/users')

    const concepts = await harvestAppConcepts(scanDir)
    const modules = concepts.candidates.filter(c => c.kind === 'module').map(c => c.canonicalName)
    const models = concepts.candidates.filter(c => c.kind === 'model').map(c => c.canonicalName)
    expect(modules).toEqual(expect.arrayContaining(['UserAPI']))
    expect(models).toEqual(
      expect.arrayContaining([
        'RoomUser',
        'room_users',
        'BillingAccount',
        'billing_accounts',
        'User',
        'BlogPost',
      ])
    )
  })
})

describe('harvestRepoEntities', () => {
  it('[TC-8] Given package and fly declaring the same name, when merged, then two candidates for registry merge', async () => {
    await writePackage(scanDir, { name: 'edge-worker', dependencies: { koa: '2' } })
    await writeFile(path.join(scanDir, 'fly.toml'), 'app = "edge-worker"\n')
    const result = await harvestRepoEntities(scanDir)
    // Same name from two sources — registry upsert merges them by (kind, name).
    expect(result.candidates.filter(c => c.canonicalName === 'edge-worker')).toHaveLength(2)
  })
})

describe('multi-language package harvest', () => {
  it('[TC-11] Given go.mod with gin, when harvested, then module is a service', async () => {
    await writeFile(
      path.join(scanDir, 'go.mod'),
      [
        'module github.com/acme/payments',
        'go 1.22',
        '',
        'require github.com/gin-gonic/gin v1.9.1',
      ].join('\n')
    )
    const result = await harvestGoEcosystem(scanDir)
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]?.canonicalName).toBe('github.com/acme/payments')
    expect(result.candidates[0]?.kind).toBe('service')
  })

  it('[TC-12] Given pyproject.toml with fastapi, when harvested, then project is a service', async () => {
    await writeFile(
      path.join(scanDir, 'pyproject.toml'),
      [
        '[project]',
        'name = "billing-api"',
        'description = "Billing HTTP API"',
        'dependencies = ["fastapi>=0.110", "uvicorn"]',
      ].join('\n')
    )
    const result = await harvestPythonEcosystem(scanDir)
    expect(result.candidates[0]?.canonicalName).toBe('billing-api')
    expect(result.candidates[0]?.kind).toBe('service')
  })

  it('[TC-13] Given Cargo.toml with clap bin, when harvested, then package is a cli', async () => {
    await writeFile(
      path.join(scanDir, 'Cargo.toml'),
      [
        '[package]',
        'name = "acme-ctl"',
        'version = "0.1.0"',
        '',
        '[[bin]]',
        'name = "acme-ctl"',
        'path = "src/main.rs"',
        '',
        '[dependencies]',
        'clap = "4"',
      ].join('\n')
    )
    const result = await harvestRustEcosystem(scanDir)
    expect(result.candidates[0]?.canonicalName).toBe('acme-ctl')
    expect(result.candidates[0]?.kind).toBe('cli')
  })

  it('[TC-14] Given composer.json with laravel, when harvested, then package is a service', async () => {
    await writeFile(
      path.join(scanDir, 'composer.json'),
      JSON.stringify({
        name: 'acme/storefront',
        description: 'Storefront',
        require: { 'laravel/framework': '^11.0', php: '^8.2' },
      })
    )
    const result = await harvestPhpEcosystem(scanDir)
    expect(result.candidates[0]?.canonicalName).toBe('acme/storefront')
    expect(result.candidates[0]?.kind).toBe('service')
  })

  it('[TC-15] Given Gemfile with rails, when harvested, then Gemfile-only app is a service', async () => {
    await writeFile(
      path.join(scanDir, 'Gemfile'),
      ['source "https://rubygems.org"', 'gem "rails", "~> 7.1"', 'gem "pg"'].join('\n')
    )
    const result = await harvestRubyEcosystem(scanDir)
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]?.canonicalName).toBe(path.basename(scanDir))
    expect(result.candidates[0]?.kind).toBe('service')
    expect(result.candidates[0]?.sourceFile).toBe('Gemfile')
  })

  it('[TC-16] Given multi-module pom.xml, when harvested, then modules get identity and part_of', async () => {
    await writeFile(
      path.join(scanDir, 'pom.xml'),
      [
        '<project>',
        '  <artifactId>acme-parent</artifactId>',
        '  <packaging>pom</packaging>',
        '  <modules>',
        '    <module>payments</module>',
        '  </modules>',
        '</project>',
      ].join('\n')
    )
    await mkdir(path.join(scanDir, 'payments'), { recursive: true })
    await writeFile(
      path.join(scanDir, 'payments', 'pom.xml'),
      [
        '<project>',
        '  <groupId>com.acme</groupId>',
        '  <artifactId>payments</artifactId>',
        '  <description>Payments API</description>',
        '  <dependencies>',
        '    <dependency>',
        '      <groupId>org.springframework.boot</groupId>',
        '      <artifactId>spring-boot-starter-web</artifactId>',
        '    </dependency>',
        '  </dependencies>',
        '</project>',
      ].join('\n')
    )
    const result = await harvestJavaEcosystem(scanDir)
    const byName = new Map(result.candidates.map(c => [c.canonicalName, c]))
    expect(byName.get('acme-parent')).toBeTruthy()
    expect(byName.get('payments')?.kind).toBe('service')
    expect(byName.get('payments')?.aliases).toContain('com.acme:payments')
    expect(result.edges).toContainEqual({
      fromName: 'payments',
      toName: 'acme-parent',
      edgeType: 'part_of',
    })
  })

  it('[TC-17] Given *.cabal with servant, when harvested, then package is a service', async () => {
    await writeFile(
      path.join(scanDir, 'billing.cabal'),
      [
        'name:                billing-api',
        'version:             0.1.0.0',
        'library',
        '  build-depends:       base, servant, servant-server',
        'executable billing',
        '  build-depends:       base, billing-api',
      ].join('\n')
    )
    const result = await harvestHaskellEcosystem(scanDir)
    expect(result.candidates[0]?.canonicalName).toBe('billing-api')
    expect(result.candidates[0]?.kind).toBe('service')
  })

  it('[TC-18] Given CMakeLists.txt project(), when harvested, then low-confidence library candidate', async () => {
    await writeFile(
      path.join(scanDir, 'CMakeLists.txt'),
      [
        'cmake_minimum_required(VERSION 3.16)',
        'project(raylib)',
        'add_library(raylib STATIC src.c)',
      ].join('\n')
    )
    const result = await harvestCppEcosystem(scanDir)
    expect(result.candidates[0]?.canonicalName).toBe('raylib')
    expect(result.candidates[0]?.kind).toBe('library')
    expect(result.candidates[0]?.confidence).toBeLessThanOrEqual(0.45)
  })

  it('[TC-19] Given *.csproj Sdk.Web, when harvested, then project is a service with sln part_of', async () => {
    await writeFile(
      path.join(scanDir, 'Acme.sln'),
      [
        'Microsoft Visual Studio Solution File, Format Version 12.00',
        'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Payments", "Payments\\Payments.csproj", "{11111111-1111-1111-1111-111111111111}"',
        'EndProject',
      ].join('\n')
    )
    await mkdir(path.join(scanDir, 'Payments'), { recursive: true })
    await writeFile(
      path.join(scanDir, 'Payments', 'Payments.csproj'),
      [
        '<Project Sdk="Microsoft.NET.Sdk.Web">',
        '  <PropertyGroup>',
        '    <TargetFramework>net8.0</TargetFramework>',
        '    <RootNamespace>Acme.Payments</RootNamespace>',
        '    <AssemblyName>Acme.Payments</AssemblyName>',
        '  </PropertyGroup>',
        '</Project>',
      ].join('\n')
    )
    const result = await harvestCsharpEcosystem(scanDir)
    expect(result.candidates[0]?.canonicalName).toBe('Acme.Payments')
    expect(result.candidates[0]?.kind).toBe('service')
    expect(result.candidates[0]?.aliases).toContain('Acme.Payments')
    expect(result.edges).toContainEqual({
      fromName: 'Acme.Payments',
      toName: 'Acme',
      edgeType: 'part_of',
    })
  })

  it('[TC-20] Given build.sbt with play, when harvested, then project is a service', async () => {
    await writeFile(
      path.join(scanDir, 'build.sbt'),
      [
        'name := "storefront"',
        'libraryDependencies += "org.playframework" %% "play" % "3.0.0"',
      ].join('\n')
    )
    const result = await harvestScalaEcosystem(scanDir)
    expect(result.candidates[0]?.canonicalName).toBe('storefront')
    expect(result.candidates[0]?.kind).toBe('service')
  })
})
