# Terraform for the Fly.io chat-demo apps (kb-demo / kb-demo-builder).
#
# Scope is deliberately narrow: only `fly_app` (the one-time `fly apps create`
# step) is declared here. Everything else in FLY_ORCHESTRATION.md's one-time
# setup stays CLI-driven, because no Fly Terraform provider — official or
# community fork — has a resource for it:
#   - Secrets (`fly secrets set`): no `fly_secret` resource exists.
#   - Tigris storage (`fly storage create`): no resource wires a bucket to an
#     app as a storage extension; the separate tigrisdata/terraform-provider-tigris
#     only manages raw buckets, not that linkage.
#   - The builder's scheduled machine (`fly machine run --schedule daily`):
#     `fly_machine` has no `schedule`/`restart` attribute in any provider we
#     found, so it can't be expressed here — scripts/fly/deploy.sh owns it.
#   - kb-demo's serving machine: already owned by `fly deploy -c fly.toml`'s
#     own release process; a second owner (Terraform) would fight it for the
#     same machine.
#
# The official fly-apps/terraform-provider-fly is archived (read-only since
# 2024-03); this uses the andrewbaxter/fly fork, which is still the resource
# source used below.

terraform {
  required_providers {
    fly = {
      source  = "andrewbaxter/fly"
      version = "~> 0.1"
    }
  }
}

provider "fly" {
  # Reads FLY_API_TOKEN from the environment if unset here — see README.md.
}

resource "fly_app" "kb_demo" {
  name = "kb-demo"
  org  = "personal"
  # kb-demo serves chat traffic and has a real shared IPv4 (66.241.125.217) —
  # must be true or Terraform will try to unassign it.
  assign_shared_ip_address = true
}

resource "fly_app" "kb_demo_builder" {
  name = "kb-demo-builder"
  org  = "personal"
  # Batch job, no [http_service], no IP assigned — matches current state.
  assign_shared_ip_address = false
}
