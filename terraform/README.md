# Terraform (Fly.io apps)

Manages the two `fly_app` resources (`kb-demo`, `kb-demo-builder`) — the
`fly apps create` step from `FLY_ORCHESTRATION.md`'s one-time setup. Nothing
else in that setup fits Terraform today; see the comment at the top of
`main.tf` for why (no provider resource for secrets, Tigris storage, the
builder's scheduled machine, or kb-demo's `fly deploy`-owned machine).

## Use

```bash
export FLY_API_TOKEN="$(fly auth token)"   # or a scoped token: fly tokens create org personal
cd terraform
terraform init
terraform plan     # should show no changes once imported (see below)
```

## Importing the existing apps

These apps already exist (created by hand before Terraform was introduced).
Import them once so Terraform adopts them instead of trying to recreate them:

```bash
terraform import fly_app.kb_demo kb-demo
terraform import fly_app.kb_demo_builder kb-demo-builder
```
