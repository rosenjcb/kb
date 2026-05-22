---
layout: default
title: Knowledge Graph
permalink: /graph.html
nav_order: 1
---

# Knowledge Graph

This page renders the current published KB graph using Cytoscape.js.

<div id="kb-graph-meta" style="margin-bottom: 1rem; color: #666;">Loading graph…</div>
<div id="kb-graph" style="width: 100%; height: 80vh; min-height: 720px; border: 1px solid #e5e7eb; border-radius: 12px;"></div>

<script src="https://unpkg.com/cytoscape@3.30.2/dist/cytoscape.min.js"></script>
<script>
  async function loadKbGraph() {
    const meta = document.getElementById('kb-graph-meta')
    const container = document.getElementById('kb-graph')

    try {
      const response = await fetch('{{ "/assets/generated/kb-graph.json" | relative_url }}')
      if (!response.ok) {
        throw new Error('Graph data request failed with status ' + response.status)
      }

      const payload = await response.json()
      const entities = Array.isArray(payload.entities) ? payload.entities : []
      const relationships = Array.isArray(payload.relationships) ? payload.relationships : []

      meta.textContent =
        entities.length === 0 && relationships.length === 0
          ? 'No graph data has been published yet. Run kb init, then kb publish jekyll --apply.'
          : entities.length + ' nodes, ' + relationships.length + ' edges. Click a node to focus its neighborhood.'

      const entityIds = new Set(entities.map(e => e.id))
      const elements = [
        ...entities.map(entity => ({
          data: {
            id: entity.id,
            label: entity.name || entity.id,
            type: entity.type || 'concept',
          },
        })),
        ...relationships
          .filter(r => entityIds.has(r.fromId) && entityIds.has(r.toId))
          .map((relationship, index) => ({
            data: {
              id: relationship.fromId + '__' + relationship.type + '__' + relationship.toId + '__' + index,
              source: relationship.fromId,
              target: relationship.toId,
              label: relationship.type,
            },
          })),
      ]

      const cy = cytoscape({
        container,
        elements,
        layout: {
          name: 'cose',
          animate: false,
          fit: true,
          padding: 140,
          randomize: true,
          componentSpacing: 220,
          nodeRepulsion: 280000,
          idealEdgeLength: 120,
          edgeElasticity: 80,
          nestingFactor: 0.8,
          gravity: 0.1,
          numIter: 2200,
          initialTemp: 180,
          coolingFactor: 0.96,
          minTemp: 1,
        },
        wheelSensitivity: 0.18,
        minZoom: 0.08,
        maxZoom: 3,
        style: [
          {
            selector: 'node',
            style: {
              'background-color': '#2563eb',
              color: '#0f172a',
              label: 'data(label)',
              'font-size': 8,
              'min-zoomed-font-size': 7,
              'text-wrap': 'wrap',
              'text-max-width': 72,
              'text-valign': 'bottom',
              'text-margin-y': 8,
              width: 12,
              height: 12,
            },
          },
          {
            selector: 'node[type = "system"]',
            style: { 'background-color': '#0f766e' },
          },
          {
            selector: 'node[type = "tool"]',
            style: { 'background-color': '#7c3aed' },
          },
          {
            selector: 'node[type = "decision"]',
            style: { 'background-color': '#b45309' },
          },
          {
            selector: 'node[type = "person"]',
            style: { 'background-color': '#be123c' },
          },
          {
            selector: 'node.focused',
            style: {
              'border-width': 2,
              'border-color': '#f8fafc',
              width: 16,
              height: 16,
            },
          },
          {
            selector: '.dimmed',
            style: {
              opacity: 0.14,
            },
          },
          {
            selector: 'edge',
            style: {
              width: 1,
              'line-color': '#94a3b8',
              'target-arrow-color': '#94a3b8',
              'target-arrow-shape': 'triangle',
              'curve-style': 'bezier',
              label: '',
              'font-size': 7,
              'min-zoomed-font-size': 6,
              color: '#64748b',
              'text-background-color': '#ffffff',
              'text-background-opacity': 0.72,
              'text-background-padding': 2,
              opacity: 0.6,
            },
          },
          {
            selector: 'edge.focused',
            style: {
              width: 1.8,
              opacity: 0.92,
            },
          },
        ],
      })

      function clearFocus() {
        cy.elements().removeClass('dimmed focused')
      }

      cy.on('tap', 'node', event => {
        const node = event.target
        const neighborhood = node.closedNeighborhood()
        clearFocus()
        cy.elements().addClass('dimmed')
        neighborhood.removeClass('dimmed')
        neighborhood.addClass('focused')
      })

      cy.on('tap', event => {
        if (event.target === cy) {
          clearFocus()
        }
      })
    } catch (error) {
      meta.textContent = 'Failed to load graph data.'
      container.innerHTML = '<p style="padding: 1rem;">' + String(error) + '</p>'
    }
  }

  loadKbGraph()
</script>
