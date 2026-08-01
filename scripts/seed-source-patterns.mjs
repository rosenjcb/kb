/**
 * One-shot seed: append / replace `source_patterns:` in ecosystem YAML files.
 * Run: node scripts/seed-source-patterns.mjs
 *
 * After seeding, YAML is the runtime driver. Re-run only when regenerating
 * the full pattern set from this script's definitions.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dump as dumpYaml } from 'js-yaml'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ecoDir = join(root, 'packages/kb-core/src/tools/ecosystems')

const TS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']
const PY = ['.py']
const GO = ['.go']
const JV = ['.java', '.kt', '.kts']
const CS = ['.cs']
const PHP = ['.php']
const RS = ['.rs']
const RB = ['.rb']
const SC = ['.scala']
const HS = ['.hs', '.lhs']
const CPP = ['.cpp', '.cc', '.cxx', '.h', '.hpp']
const GQL = ['.graphql', '.gql']
const YAML = ['.yaml', '.yml']
const SQL = ['.sql']
const XML = ['.xml']
const PRISMA = ['.prisma']

const route = (id, extras) => ({
  id,
  kind: 'api',
  confidence: 0.5,
  filter: 'plausible_http_route',
  strategy: 'regex',
  ...extras,
})
const _surface = (id, extras) => ({
  id,
  kind: 'surface',
  confidence: 0.5,
  filter: 'plausible_http_route',
  strategy: 'regex',
  ...extras,
})
const mod = (id, extras) => ({
  id,
  kind: 'module',
  confidence: 0.55,
  filter: 'plausible_type_name',
  strategy: 'regex',
  ...extras,
})
const model = (id, extras) => ({
  id,
  kind: 'model',
  confidence: 0.55,
  filter: 'plausible_model_name',
  strategy: 'regex',
  ...extras,
})
const files = extensions => ({ files: { extensions } })

/** @type {Record<string, object[]>} */
const byEco = {
  common: [
    {
      id: 'openapi_path_items',
      kind: 'api',
      gloss: 'OpenAPI path item',
      confidence: 0.75,
      filter: 'plausible_http_route',
      strategy: 'openapi_path_items',
      phase: 'contracts',
      ...files([...YAML, '.json']),
    },
    {
      id: 'graphql_root_operations',
      kind: 'api',
      gloss: 'GraphQL root operation',
      confidence: 0.5,
      filter: 'plausible_http_route',
      strategy: 'regex',
      pattern: '^\\s*(?:type|extend\\s+type)\\s+(Query|Mutation|Subscription)\\s*[@{]',
      flags: 'gm',
      name_template: '/graphql/{1}',
      ...files(GQL),
    },
    {
      id: 'graphql_object_types',
      kind: 'model',
      gloss: 'GraphQL type',
      confidence: 0.55,
      filter: 'plausible_type_name',
      strategy: 'regex',
      pattern: '^\\s*type\\s+([A-Z][A-Za-z0-9_]*)\\s*[@{]',
      flags: 'gm',
      name_group: 1,
      skip_names: ['Query', 'Mutation', 'Subscription'],
      ...files(GQL),
    },
    {
      id: 'sql_create_table_files',
      kind: 'model',
      gloss: 'SQL table',
      confidence: 0.55,
      filter: 'plausible_model_name',
      strategy: 'embedded_sql_ddl',
      ...files(SQL),
    },
    {
      id: 'embedded_sql_ddl_source',
      kind: 'model',
      gloss: 'SQL table (embedded)',
      confidence: 0.55,
      filter: 'plausible_model_name',
      strategy: 'embedded_sql_ddl',
      ...files([...TS, ...PY, ...GO, ...JV, ...RB, ...CS, ...PHP, ...RS]),
    },
    {
      id: 'raw_node_http_dispatch',
      kind: 'api',
      gloss: 'Raw Node HTTP route',
      confidence: 0.5,
      filter: 'plausible_http_route',
      strategy: 'router_group_prefix_join',
      join_style: 'raw_node_http',
      ...files(TS),
    },
    {
      id: 'play_conf_routes',
      kind: 'api',
      gloss: 'Play Framework route',
      confidence: 0.5,
      filter: 'plausible_http_route',
      strategy: 'regex',
      pattern: '^\\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\\s+(\\/\\S+)',
      flags: 'gm',
      name_template: '{1} {2}',
      files: { basenames: ['routes'], path_suffixes: ['conf/routes'] },
    },
  ],

  typescript: [
    {
      id: 'next_filesystem_routes',
      kind: 'api',
      gloss: 'Next.js route',
      confidence: 0.5,
      filter: 'plausible_http_route',
      strategy: 'next_filesystem_routes',
      ...files(TS),
    },
    {
      id: 'nest_controller_method_join',
      kind: 'api',
      gloss: 'NestJS route',
      confidence: 0.5,
      filter: 'plausible_http_route',
      strategy: 'class_method_prefix_join',
      join_style: 'nest',
      ...files(TS),
    },
    {
      id: 'nest_global_prefix_join',
      kind: 'api',
      gloss: 'NestJS global prefix route',
      confidence: 0.5,
      filter: 'plausible_http_route',
      strategy: 'class_method_prefix_join',
      join_style: 'nest_global_prefix',
      ...files(TS),
    },
    {
      id: 'trpc_procedures',
      kind: 'api',
      gloss: 'tRPC procedure',
      confidence: 0.5,
      filter: 'plausible_http_route',
      strategy: 'trpc_procedures',
      ...files(TS),
    },
    route('express_koa_hono_verbs', {
      gloss: 'Express/Koa/Hono route',
      pattern:
        '\\b(?:app|router|r|hono|api)\\.(get|post|put|patch|delete|options|head|all)\\s*\\(\\s*[\'"]([^\'"]+)[\'"]',
      flags: 'gi',
      name_template: '{1|upper} {2}',
      ...files(TS),
    }),
    mod('nest_decorator_classes', {
      gloss: 'NestJS application class',
      pattern:
        '@(?:Injectable|Controller|Catch|Resolver|Module)\\b[^\\n]*\\n(?:\\s*@[^\\n]+\\n)*\\s*export\\s+class\\s+([A-Z][A-Za-z0-9_]*)',
      flags: 'g',
      name_group: 1,
      ...files(TS),
    }),
    mod('ts_app_layer_suffix_classes', {
      gloss: 'Application layer class',
      pattern:
        'export\\s+class\\s+([A-Z][A-Za-z0-9_]*(?:Service|Controller|Handler|Repository|UseCase|Interactor|Resolver|Gateway|Store|Indexer|Registry|Pipeline|Orchestrator))\\b',
      flags: 'g',
      name_group: 1,
      ...files(TS),
    }),
    model('typeorm_entity_string', {
      gloss: 'TypeORM/MikroORM entity',
      pattern:
        '@Entity\\s*\\(\\s*[\'"]([^\'"]+)[\'"]\\s*\\)[^\\n]*\\n(?:\\s*@[^\\n]+\\n)*\\s*export\\s+class\\s+([A-Z][A-Za-z0-9_]*)',
      flags: 'g',
      name_group: 2,
      alias_groups: [2, 1],
      ...files(TS),
    }),
    model('typeorm_entity_object_name', {
      gloss: 'TypeORM/MikroORM entity',
      pattern:
        '@Entity\\s*\\(\\s*\\{[^}]*\\b(?:name|tableName)\\s*:\\s*[\'"]([^\'"]+)[\'"][^}]*\\}\\s*\\)[^\\n]*\\n(?:\\s*@[^\\n]+\\n)*\\s*export\\s+class\\s+([A-Z][A-Za-z0-9_]*)',
      flags: 'g',
      name_group: 2,
      alias_groups: [2, 1],
      ...files(TS),
    }),
    model('typeorm_entity_bare', {
      gloss: 'TypeORM/MikroORM entity',
      pattern:
        '@Entity\\b[^\\n]*\\n(?:\\s*@[^\\n]+\\n)*\\s*export\\s+class\\s+([A-Z][A-Za-z0-9_]*)',
      flags: 'g',
      name_group: 1,
      ...files(TS),
    }),
    model('sequelize_define', {
      gloss: 'Sequelize model',
      pattern: '\\b(?:sequelize|Sequelize)\\.define\\s*\\(\\s*[\'"]([A-Za-z][A-Za-z0-9_]*)[\'"]',
      flags: 'g',
      name_group: 1,
      ...files(TS),
    }),
    model('sequelize_model_subclass', {
      gloss: 'Sequelize Model subclass',
      pattern: 'export\\s+class\\s+([A-Z][A-Za-z0-9_]*)\\s+extends\\s+Model\\b',
      flags: 'g',
      name_group: 1,
      ...files(TS),
    }),
    model('mongoose_model', {
      gloss: 'Mongoose model',
      pattern: '\\bmongoose\\.model\\s*\\(\\s*[\'"]([A-Za-z][A-Za-z0-9_]*)[\'"]',
      flags: 'g',
      name_group: 1,
      ...files(TS),
    }),
    model('drizzle_table', {
      gloss: 'Drizzle table',
      pattern: '\\b(?:pgTable|mysqlTable|sqliteTable)\\s*\\(\\s*[\'"]([a-z][a-z0-9_]*)[\'"]',
      flags: 'g',
      name_group: 1,
      ...files(TS),
    }),
    {
      id: 'prisma_schema_blocks',
      kind: 'model',
      gloss: 'Prisma schema atom',
      confidence: 0.55,
      filter: 'plausible_model_name',
      strategy: 'prisma_schema_blocks',
      ...files([...PRISMA, ...TS]),
    },
  ],

  python: [
    route('fastapi_decorator_verbs', {
      gloss: 'FastAPI/Starlette route',
      pattern:
        '@(?:app|router|api_router|api)\\.(get|post|put|patch|delete|options|head)\\s*\\(\\s*[\'"]([^\'"]+)[\'"]',
      flags: 'gi',
      name_template: '{1|upper} {2}',
      ...files(PY),
    }),
    {
      id: 'fastapi_router_prefix_join',
      kind: 'api',
      gloss: 'FastAPI APIRouter prefix join',
      confidence: 0.5,
      filter: 'plausible_http_route',
      strategy: 'router_group_prefix_join',
      join_style: 'fastapi',
      ...files(PY),
    },
    {
      id: 'asgi_route_mount',
      kind: 'api',
      gloss: 'ASGI Route/Mount',
      confidence: 0.5,
      filter: 'plausible_http_route',
      strategy: 'router_group_prefix_join',
      join_style: 'asgi',
      ...files(PY),
    },
    route('flask_route_decorator', {
      gloss: 'Flask route',
      pattern: '@(?:app|bp|blueprint)\\.route\\s*\\(\\s*[\'"]([^\'"]+)[\'"]',
      flags: 'gi',
      name_group: 1,
      ...files(PY),
    }),
    route('flask_add_url_rule', {
      gloss: 'Flask add_url_rule',
      pattern: '\\.add_url_rule\\s*\\(\\s*[\'"]([^\'"]+)[\'"]',
      flags: 'g',
      name_template: '{1|/}',
      ...files(PY),
    }),
    route('flask_method_view_route', {
      gloss: 'Flask MethodView',
      pattern: '^class\\s+([A-Z][A-Za-z0-9_]*)\\s*\\(\\s*MethodView\\s*\\)',
      flags: 'gm',
      name_template: 'flask:{1}',
      alias_groups: [1],
      filter: 'none',
      ...files(PY),
    }),
    {
      id: 'django_include_join',
      kind: 'api',
      gloss: 'Django path/include join',
      confidence: 0.5,
      filter: 'plausible_http_route',
      strategy: 'django_include_join',
      ...files(PY),
    },
    route('django_app_name', {
      gloss: 'Django app_name',
      pattern: '\\bapp_name\\s*=\\s*[\'"]([a-z][a-z0-9_]*)[\'"]',
      flags: 'g',
      name_template: 'django-app/{1}',
      alias_groups: [1],
      filter: 'none',
      ...files(PY),
    }),
    mod('python_app_suffix_classes', {
      gloss: 'Python application class',
      pattern:
        '^class\\s+([A-Z][A-Za-z0-9_]*(?:Service|Controller|Handler|Presenter|UseCase|Interactor|ViewSet|APIView))\\s*[\\(:]',
      flags: 'gm',
      name_group: 1,
      ...files(PY),
    }),
    mod('flask_method_view_module', {
      gloss: 'Flask MethodView',
      pattern: '^class\\s+([A-Z][A-Za-z0-9_]*)\\s*\\(\\s*MethodView\\s*\\)',
      flags: 'gm',
      name_group: 1,
      ...files(PY),
    }),
    model('python_orm_model_class', {
      gloss: 'ORM model class',
      pattern:
        '^class\\s+([A-Z][A-Za-z0-9_]*)\\s*\\(\\s*(?:models\\.Model|Base|db\\.Model|SQLModel|Model|tortoise\\.models\\.Model)\\s*\\)',
      flags: 'gm',
      name_group: 1,
      ...files(PY),
    }),
    model('pydantic_sqlmodel_schema', {
      gloss: 'Pydantic/SQLModel schema',
      pattern: '^class\\s+([A-Z][A-Za-z0-9_]*)\\s*\\(\\s*(?:BaseModel|SQLModel)\\s*\\)',
      flags: 'gm',
      name_group: 1,
      ...files(PY),
    }),
    model('sqlalchemy_tablename', {
      gloss: 'SQLAlchemy table',
      pattern: '__tablename__\\s*=\\s*[\'"]([^\'"]+)[\'"]',
      flags: 'g',
      name_group: 1,
      alias_groups: [1],
      ...files(PY),
    }),
    model('peewee_table_name', {
      gloss: 'Peewee/ORM table_name',
      pattern: 'table_name\\s*=\\s*[\'"]([^\'"]+)[\'"]',
      flags: 'g',
      name_group: 1,
      alias_groups: [1],
      ...files(PY),
    }),
  ],

  go: [
    {
      id: 'go_group_prefix_join',
      kind: 'api',
      gloss: 'Gin/chi Group join',
      confidence: 0.5,
      filter: 'plausible_http_route',
      strategy: 'router_group_prefix_join',
      join_style: 'go_group',
      ...files(GO),
    },
    route('go_router_verbs', {
      gloss: 'Go router verb',
      pattern:
        '\\b(?:r|router|mux|e|app)\\.(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|Any|Handle|Get|Post|Put|Patch|Delete)\\s*\\(\\s*"([^"]+)"',
      flags: 'g',
      name_template: '{1|http_verb} {2}',
      ...files(GO),
    }),
    route('go_http_handle_func', {
      gloss: 'http.HandleFunc',
      pattern: '\\bhttp\\.HandleFunc\\s*\\(\\s*"([^"]+)"',
      flags: 'g',
      name_group: 1,
      ...files(GO),
    }),
    route('go122_servemux_method', {
      gloss: 'Go 1.22 ServeMux',
      pattern:
        '\\b(?:mux|http\\.DefaultServeMux|\\w+)\\.(?:Handle|HandleFunc)\\s*\\(\\s*"(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\\s+(\\/[^"]*)"',
      flags: 'g',
      name_template: '{1} {2}',
      ...files(GO),
    }),
    route('go_chi_mount_route', {
      gloss: 'chi Mount/Route',
      pattern: '\\b(?:r|router)\\.(?:Mount|Route)\\s*\\(\\s*"(\\/[^"]*)"',
      flags: 'g',
      name_group: 1,
      ...files(GO),
    }),
    mod('go_app_structs', {
      gloss: 'Go application struct',
      pattern:
        '\\btype\\s+([A-Z][A-Za-z0-9_]*(?:Service|Handler|Controller|Repository|Server|API|Usecase|UseCase))\\s+struct\\b',
      flags: 'g',
      name_group: 1,
      ...files(GO),
    }),
    model('gorm_model_struct', {
      gloss: 'GORM model',
      pattern: '\\btype\\s+([A-Z][A-Za-z0-9_]*)\\s+struct\\s*\\{[^}]*\\bgorm\\.(?:Model|DeletedAt)\\b',
      flags: 'gs',
      name_group: 1,
      ...files(GO),
    }),
    model('gorm_tablename_method', {
      gloss: 'GORM TableName model',
      pattern: 'func\\s+\\(\\s*[A-Za-z0-9_*]+\\s+([A-Z][A-Za-z0-9_]*)\\s*\\)\\s+TableName\\s*\\(',
      flags: 'g',
      name_group: 1,
      ...files(GO),
    }),
    model('ent_schema_fields', {
      gloss: 'ent schema',
      pattern: 'func\\s+\\(([A-Z][A-Za-z0-9_]*)\\)\\s+Fields\\s*\\(\\s*\\)\\s*\\[\\]ent\\.Field',
      flags: 'g',
      name_group: 1,
      ...files(GO),
    }),
  ],

  java: [
    {
      id: 'spring_class_method_join',
      kind: 'api',
      gloss: 'Spring MVC mapping',
      confidence: 0.5,
      filter: 'plausible_http_route',
      strategy: 'class_method_prefix_join',
      join_style: 'spring',
      ...files(JV),
    },
    {
      id: 'micronaut_controller_join',
      kind: 'api',
      gloss: 'Micronaut controller route',
      confidence: 0.5,
      filter: 'plausible_http_route',
      strategy: 'class_method_prefix_join',
      join_style: 'micronaut',
      ...files(JV),
    },
    {
      id: 'jaxrs_path_join',
      kind: 'api',
      gloss: 'JAX-RS path join',
      confidence: 0.5,
      filter: 'plausible_http_route',
      strategy: 'class_method_prefix_join',
      join_style: 'jaxrs',
      ...files(JV),
    },
    route('jaxrs_path_annotation', {
      gloss: 'JAX-RS @Path',
      pattern: '@Path\\s*\\(\\s*[\'"]([^\'"]+)[\'"]\\s*\\)',
      flags: 'g',
      name_group: 1,
      ...files(JV),
    }),
    route('ktor_verb_routes', {
      gloss: 'Ktor route',
      pattern: '\\b(?:get|post|put|patch|delete|head|options)\\s*\\(\\s*"(\\/[^"]*)"\\s*\\)',
      flags: 'g',
      name_group: 1,
      ...files(JV),
    }),
    route('ktor_route_block', {
      gloss: 'Ktor route block',
      pattern: '\\broute\\s*\\(\\s*"(\\/[^"]*)"\\s*\\)\\s*\\{',
      flags: 'g',
      name_group: 1,
      ...files(JV),
    }),
    mod('spring_app_classes', {
      gloss: 'Spring/Jakarta application class',
      pattern:
        '@(?:Service|RestController|Controller|Repository|Component|Dao)\\b[^\\n]*\\n(?:\\s*@[^\\n]+\\n)*\\s*(?:public\\s+|internal\\s+|open\\s+)?(?:class|object)\\s+([A-Z][A-Za-z0-9_]*)',
      flags: 'g',
      name_group: 1,
      ...files(JV),
    }),
    model('jpa_entity_class', {
      gloss: 'JPA/Mongo/Room entity',
      pattern:
        '@(?:Entity|Document)\\b[^\\n]*\\n(?:\\s*@[^\\n]+\\n)*\\s*(?:public\\s+|internal\\s+)?(?:class|data\\s+class)\\s+([A-Z][A-Za-z0-9_]*)',
      flags: 'g',
      name_group: 1,
      ...files(JV),
    }),
    model('room_tablename', {
      gloss: 'Room tableName',
      pattern: '@Entity\\s*\\([^)]*tableName\\s*=\\s*["\']([^"\']+)["\']',
      flags: 'g',
      name_group: 1,
      alias_groups: [1],
      ...files(JV),
    }),
    model('jpa_table_annotation', {
      gloss: 'JPA @Table',
      pattern: '@Table\\s*\\(\\s*(?:name\\s*=\\s*)?["\']([^"\']+)["\']',
      flags: 'g',
      name_group: 1,
      alias_groups: [1],
      ...files(JV),
    }),
    model('exposed_table', {
      gloss: 'Exposed Table',
      pattern: '\\bobject\\s+([A-Z][A-Za-z0-9_]*)\\s*:\\s*Table\\s*\\(\\s*"([^"]+)"\\s*\\)',
      flags: 'g',
      name_group: 1,
      alias_groups: [1, 2],
      files: { extensions: ['.kt', '.kts'] },
    }),
    {
      id: 'hibernate_xml_mappings',
      kind: 'model',
      gloss: 'Hibernate mapping',
      confidence: 0.55,
      filter: 'plausible_model_name',
      strategy: 'regex',
      pattern: '<class\\s+[^>]*\\bname\\s*=\\s*["\']([^"\']+)["\'][^>]*\\btable\\s*=\\s*["\']([^"\']+)["\']',
      flags: 'gi',
      name_template: '{1|class_leaf}',
      alias_groups: [1, 2],
      emit_extra_group_as_model: 2,
      ...files(XML),
    },
    model('hibernate_xml_table_name_first', {
      gloss: 'Hibernate class',
      pattern:
        '<class\\s+[^>]*\\btable\\s*=\\s*["\']([^"\']+)["\'][^>]*\\bname\\s*=\\s*["\']([^"\']+)["\']',
      flags: 'gi',
      name_template: '{2|class_leaf}',
      alias_groups: [2, 1],
      emit_extra_group_as_model: 1,
      ...files(XML),
    }),
    model('jpa_orm_xml_entity', {
      gloss: 'JPA orm.xml entity',
      pattern: '<entity\\s+[^>]*\\bclass\\s*=\\s*["\']([^"\']+)["\']',
      flags: 'gi',
      name_template: '{1|class_leaf}',
      ...files(XML),
    }),
    model('jpa_orm_xml_table', {
      gloss: 'JPA orm.xml table',
      pattern: '<table\\s+[^>]*\\bname\\s*=\\s*["\']([^"\']+)["\']',
      flags: 'gi',
      name_group: 1,
      alias_groups: [1],
      ...files(XML),
    }),
  ],

  csharp: [
    route('aspnet_route_attr', {
      gloss: 'ASP.NET Route',
      pattern: '\\[Route\\s*\\(\\s*"([^"]+)"\\s*\\)\\]',
      flags: 'g',
      name_group: 1,
      ...files(CS),
    }),
    route('aspnet_http_verb_attr', {
      gloss: 'ASP.NET Http* attribute',
      pattern: '\\[Http(Get|Post|Put|Patch|Delete|Head|Options)\\s*\\(\\s*"([^"]+)"\\s*\\)\\]',
      flags: 'g',
      name_template: '{1|upper} {2}',
      ...files(CS),
    }),
    route('aspnet_map_verbs', {
      gloss: 'ASP.NET Map*',
      pattern: '\\.Map(Get|Post|Put|Patch|Delete|Methods|Group)\\s*\\(\\s*"([^"]+)"',
      flags: 'g',
      name_template: '{1|map_verb} {2}',
      ...files(CS),
    }),
    mod('aspnet_controller_class', {
      gloss: 'ASP.NET controller',
      pattern: '(?:\\[ApiController\\]|\\[Route\\b)[\\s\\S]{0,200}?class\\s+([A-Z][A-Za-z0-9_]*)',
      flags: 'g',
      name_group: 1,
      ...files(CS),
    }),
    mod('dotnet_app_suffix', {
      gloss: '.NET application class',
      pattern:
        '\\b(?:class|record)\\s+([A-Z][A-Za-z0-9_]*(?:Service|Controller|Handler|Repository|UseCase))\\b',
      flags: 'g',
      name_group: 1,
      ...files(CS),
    }),
    model('ef_table_attr', {
      gloss: 'EF Core entity',
      pattern:
        '\\[Table\\s*\\(\\s*"([^"]+)"\\s*\\)\\][\\s\\S]{0,120}?(?:class|record)\\s+([A-Z][A-Za-z0-9_]*)',
      flags: 'g',
      name_group: 2,
      alias_groups: [2, 1],
      ...files(CS),
    }),
    model('ef_dbset', {
      gloss: 'EF Core DbSet',
      pattern: '\\bDbSet<\\s*([A-Z][A-Za-z0-9_]*)\\s*>',
      flags: 'g',
      name_group: 1,
      ...files(CS),
    }),
    model('ef_totable', {
      gloss: 'EF Core ToTable',
      pattern: '\\.ToTable\\s*\\(\\s*"([^"]+)"\\s*\\)',
      flags: 'g',
      name_group: 1,
      alias_groups: [1],
      ...files(CS),
    }),
  ],

  ruby: [
    {
      id: 'rails_resources_crud',
      kind: 'api',
      gloss: 'Rails nested routes',
      confidence: 0.5,
      filter: 'plausible_http_route',
      strategy: 'rails_resources_crud',
      files: { extensions: RB, path_suffixes: ['routes.rb'] },
    },
    route('sinatra_verbs', {
      gloss: 'Sinatra route',
      pattern: '^\\s*(?:get|post|put|patch|delete|options|head)\\s+[\'"]([^\'"]+)[\'"]',
      flags: 'gm',
      name_template: '{1|/}',
      ...files(RB),
    }),
    route('grape_verbs', {
      gloss: 'Grape route',
      pattern: '\\b(?:get|post|put|patch|delete)\\s+[\'"]([^\'"]+)[\'"]',
      flags: 'g',
      name_group: 1,
      require_leading_slash: true,
      ...files(RB),
    }),
    route('grape_resource_symbol', {
      gloss: 'Grape resource',
      pattern: '\\bresource\\s+:([a-z][a-z0-9_]*)',
      flags: 'g',
      name_template: '/{1}',
      ...files(RB),
    }),
    mod('rails_controller', {
      gloss: 'Rails controller',
      pattern:
        '^class\\s+([A-Z][A-Za-z0-9_]*(?:::[A-Z][A-Za-z0-9_]*)*)\\s*<\\s*(?:ApplicationController|ActionController::Base|ActionController::API)',
      flags: 'gm',
      name_template: '{1|class_leaf}',
      alias_groups: [1],
      ...files(RB),
    }),
    mod('rails_app_suffix', {
      gloss: 'Rails application class',
      pattern:
        '^class\\s+([A-Z][A-Za-z0-9_]*(?:Service|Interactor|Worker|Job|Query|Command))\\b',
      flags: 'gm',
      name_group: 1,
      ...files(RB),
    }),
    model('activerecord_model', {
      gloss: 'ActiveRecord model',
      pattern: '^class\\s+([A-Z][A-Za-z0-9_]*)\\s*<\\s*(?:ApplicationRecord|ActiveRecord::Base)',
      flags: 'gm',
      name_group: 1,
      ...files(RB),
    }),
    model('activerecord_table_name', {
      gloss: 'ActiveRecord table_name',
      pattern: 'self\\.table_name\\s*=\\s*[\'"]([^\'"]+)[\'"]',
      flags: 'g',
      name_group: 1,
      alias_groups: [1],
      ...files(RB),
    }),
  ],

  php: [
    {
      id: 'laravel_route_facade',
      kind: 'api',
      gloss: 'Laravel Route facade',
      confidence: 0.5,
      filter: 'plausible_http_route',
      strategy: 'rails_resources_crud',
      join_style: 'laravel',
      ...files(PHP),
    },
    route('symfony_route_attr', {
      gloss: 'Symfony Route attribute',
      pattern: '#\\[Route\\s*\\(\\s*[\'"]([^\'"]+)[\'"]',
      flags: 'g',
      name_group: 1,
      ...files(PHP),
    }),
    route('symfony_route_annotation', {
      gloss: 'Symfony Route annotation',
      pattern: '@Route\\s*\\(\\s*[\'"]([^\'"]+)[\'"]',
      flags: 'g',
      name_group: 1,
      ...files(PHP),
    }),
    route('slim_verb_methods', {
      gloss: 'Slim route',
      pattern: '\\$\\w+->(get|post|put|patch|delete|options|any)\\s*\\(\\s*[\'"]([^\'"]+)[\'"]',
      flags: 'gi',
      name_template: '{1|slim_verb} {2}',
      ...files(PHP),
    }),
    route('slim_map_methods', {
      gloss: 'Slim map',
      pattern: '\\$\\w+->map\\s*\\(\\s*\\[([^\\]]+)\\]\\s*,\\s*[\'"]([^\'"]+)[\'"]',
      flags: 'g',
      name_template: '{map_verbs} {2}',
      map_verbs_group: 1,
      path_group: 2,
      ...files(PHP),
    }),
    {
      id: 'symfony_yaml_routes',
      kind: 'api',
      gloss: 'Symfony YAML route',
      confidence: 0.5,
      filter: 'plausible_http_route',
      strategy: 'symfony_yaml_routes',
      ...files(YAML),
    },
    mod('php_app_suffix', {
      gloss: 'PHP application class',
      pattern: '\\bclass\\s+([A-Z][A-Za-z0-9_]*(?:Controller|Service|Handler|Repository|Action|Job))\\b',
      flags: 'g',
      name_group: 1,
      ...files(PHP),
    }),
    model('eloquent_model', {
      gloss: 'Eloquent model',
      pattern: '\\bclass\\s+([A-Z][A-Za-z0-9_]*)\\s+extends\\s+(?:Model|Authenticatable)\\b',
      flags: 'g',
      name_group: 1,
      ...files(PHP),
    }),
    model('doctrine_entity_class', {
      gloss: 'Doctrine entity',
      pattern: '(?:#\\[ORM\\\\Entity\\b|@ORM\\\\Entity\\b)[\\s\\S]{0,400}?\\bclass\\s+([A-Z][A-Za-z0-9_]*)\\b',
      flags: 'g',
      name_group: 1,
      ...files(PHP),
    }),
    model('doctrine_table', {
      gloss: 'Doctrine table',
      pattern: '#\\[ORM\\\\Table\\s*\\(\\s*name:\\s*[\'"]([^\'"]+)[\'"]',
      flags: 'g',
      name_group: 1,
      alias_groups: [1],
      ...files(PHP),
    }),
    model('eloquent_table_prop', {
      gloss: 'Eloquent $table',
      pattern: 'protected\\s+\\$table\\s*=\\s*[\'"]([^\'"]+)[\'"]',
      flags: 'g',
      name_group: 1,
      alias_groups: [1],
      ...files(PHP),
    }),
  ],

  rust: [
    route('rocket_verb_attrs', {
      gloss: 'Rocket route',
      pattern: '#\\[(?:get|post|put|patch|delete|head|options)\\s*\\(\\s*"([^"]+)"',
      flags: 'gi',
      name_group: 1,
      ...files(RS),
    }),
    route('axum_route', {
      gloss: 'Axum route',
      pattern: '\\.route\\s*\\(\\s*"([^"]+)"\\s*,\\s*(?:get|post|put|patch|delete|any)\\b',
      flags: 'gi',
      name_group: 1,
      ...files(RS),
    }),
    route('actix_resource', {
      gloss: 'Actix resource',
      pattern: 'web::resource\\s*\\(\\s*"([^"]+)"\\s*\\)',
      flags: 'g',
      name_group: 1,
      ...files(RS),
    }),
    mod('rust_app_structs', {
      gloss: 'Rust application struct',
      pattern:
        '\\bstruct\\s+([A-Z][A-Za-z0-9_]*(?:Service|Handler|Controller|Repo|Repository|UseCase))\\b',
      flags: 'g',
      name_group: 1,
      ...files(RS),
    }),
    model('seaorm_entity', {
      gloss: 'SeaORM entity',
      pattern: '#\\[derive\\([^\\]]*EntityModel[^\\]]*\\)\\][\\s\\S]{0,80}?struct\\s+([A-Z][A-Za-z0-9_]*)',
      flags: 'g',
      name_group: 1,
      ...files(RS),
    }),
    model('diesel_table', {
      gloss: 'Diesel table',
      pattern: '\\btable!\\s*\\{\\s*([a-z][a-z0-9_]*)\\s*\\(',
      flags: 'g',
      name_group: 1,
      ...files(RS),
    }),
    model('seaorm_table_name', {
      gloss: 'SeaORM table_name',
      pattern: '#\\[sea_orm\\(table_name\\s*=\\s*"([^"]+)"\\)\\]',
      flags: 'g',
      name_group: 1,
      alias_groups: [1],
      ...files(RS),
    }),
  ],

  scala: [
    route('http4s_router_paths', {
      gloss: 'http4s route',
      pattern: '\\b(?:HttpRoutes\\.of|Router)\\([^)]*["\'](\\/[^"\']+)["\']',
      flags: 'g',
      name_group: 1,
      ...files(SC),
    }),
    route('tapir_in_segment', {
      gloss: 'Tapir .in segment',
      pattern: '\\.in\\s*\\(\\s*"([A-Za-z0-9_-]+)"\\s*\\)',
      flags: 'g',
      name_template: '/{1}',
      ...files(SC),
    }),
    mod('scala_app_types', {
      gloss: 'Scala application type',
      pattern:
        '\\b(?:class|object)\\s+([A-Z][A-Za-z0-9_]*(?:Service|Controller|Handler|Repository|Dao|DAO))\\b',
      flags: 'g',
      name_group: 1,
      ...files(SC),
    }),
    model('scala_entity', {
      gloss: 'Scala entity',
      pattern:
        '\\b(?:class|case class)\\s+([A-Z][A-Za-z0-9_]*)\\s*\\([^\\)]*\\)\\s*(?:extends|derives).*Entity',
      flags: 'g',
      name_group: 1,
      ...files(SC),
    }),
    model('slick_table_query', {
      gloss: 'Slick TableQuery',
      pattern: 'TableQuery\\[\\s*([A-Z][A-Za-z0-9_]*)\\s*\\]',
      flags: 'g',
      name_group: 1,
      ...files(SC),
    }),
  ],

  haskell: [
    route('servant_one_segment', {
      gloss: 'Servant route',
      pattern: '"([A-Za-z0-9_-]+)"\\s*:>\\s*(Get|Post|Put|Patch|Delete)\\b',
      flags: 'g',
      name_template: '{2|upper} /{1}',
      ...files(HS),
    }),
    route('servant_two_segment', {
      gloss: 'Servant nested route',
      pattern:
        '"([A-Za-z0-9_-]+)"\\s*:>\\s*"([A-Za-z0-9_-]+)"\\s*:>\\s*(Get|Post|Put|Patch|Delete)\\b',
      flags: 'g',
      name_template: '{3|upper} /{1}/{2}',
      ...files(HS),
    }),
    model('persistent_th_block', {
      gloss: 'Persistent model (TH block)',
      confidence: 0.55,
      filter: 'plausible_type_name',
      strategy: 'regex',
      pattern: '\\[persist(?:LowerCase|UpperCase|With)?\\|([\\s\\S]*?)\\|\\]',
      flags: 'g',
      name_from: 'persistent_th',
      ...files(HS),
    }),
    model('persistent_json_line', {
      gloss: 'Persistent model (quasi-quote line)',
      pattern: '^([A-Z][A-Za-z0-9_]*)\\s+json(\\s|$)',
      flags: 'gm',
      name_group: 1,
      filter: 'plausible_type_name',
      ...files(HS),
    }),
  ],

  cpp: [
    route('crow_route', {
      gloss: 'Crow route',
      pattern: 'CROW_ROUTE\\s*\\(\\s*[^,]+,\\s*"([^"]+)"\\s*\\)',
      flags: 'g',
      name_group: 1,
      ...files(CPP),
    }),
    route('drogon_add_method', {
      gloss: 'Drogon route',
      pattern:
        'ADD_METHOD_TO\\s*\\(\\s*[^,]+,\\s*"([^"]+)"\\s*,\\s*(?:Get|Post|Put|Patch|Delete)',
      flags: 'g',
      name_group: 1,
      ...files(CPP),
    }),
  ],
}

function upsertSourcePatterns(filePath, patterns) {
  const raw = readFileSync(filePath, 'utf8')
  const block = `\n# Executable tier-4 harvest rules (pattern-engine). Status/note above are summaries.\n${dumpYaml({ source_patterns: patterns }, { lineWidth: 120, noRefs: true, quotingType: "'" })}`
  if (/^source_patterns:\s*$/m.test(raw) || /^source_patterns:/m.test(raw)) {
    const next = raw.replace(/\n# Executable tier-4[\s\S]*$/m, '').replace(/\nsource_patterns:[\s\S]*$/m, '')
    writeFileSync(filePath, `${next.replace(/\s*$/, '')}\n${block}`)
  } else {
    writeFileSync(filePath, `${raw.replace(/\s*$/, '')}\n${block}`)
  }
}

// common.yaml is new
writeFileSync(
  join(ecoDir, 'common.yaml'),
  `# Cross-ecosystem source patterns (OpenAPI, GraphQL, SQL DDL, raw Node HTTP, …).
# Loaded by pattern-engine for every repo. Not a package ecosystem.

id: common
display_name: Cross-language source patterns
status: implemented

`
)
upsertSourcePatterns(join(ecoDir, 'common.yaml'), byEco.common)

for (const [id, patterns] of Object.entries(byEco)) {
  if (id === 'common') continue
  const filePath = join(ecoDir, `${id}.yaml`)
  upsertSourcePatterns(filePath, patterns)
  console.log(`seeded ${id}: ${patterns.length} patterns`)
}
console.log(`seeded common: ${byEco.common.length} patterns`)
