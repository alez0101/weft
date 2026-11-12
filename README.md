# Unified Collaboration Workspace

Homelab prototype: one Postgres data layer with thin views on top (grid, calendar,
docs, whiteboard, chat), where permissions follow the data. Runs on the Weft server.

Plan of record lives in Notion: Second Brain / Projects / Unified Collaboration Workspace.

## Layout

- `stacks/` - one Compose project per stack (Phase 1: `colanode/`)
- `data/sample/` - **synthetic** Porchfest-style dataset (fake people, streets, bands; example.com emails),
  regenerate with `python3 -I tools/gen_sample.py`. Real data, if ever used, goes in `data/` and is git-ignored.
- `tools/` - helper scripts
- `docs/` - phase write-ups and findings

## the Weft server notes

- Ports already in use on the Weft server: 8772-8775, 8790, 8795, 5037. Pick others.
- Docker log rotation is set globally (10 MB x 3) in /etc/docker/daemon.json.
- Do not run stacks on the homelab host; the homelab host only carries the Cloudflare Tunnel route.
