#!/usr/bin/env node
/**
 * dom-annotakit — GH Projects (v2) GraphQL API recon (session 3, D6 design).
 *
 * Read-only probes:
 *   1. viewer identity (token sanity)
 *   2. Mutation surface: every mutation whose name contains "rojectV2"
 *   3. Input shapes: CreateProjectV2Input / CreateProjectV2FieldInput /
 *      AddProjectV2DraftIssueInput / UpdateProjectV2DraftIssueInput /
 *      UpdateProjectV2ItemFieldValueInput / UpdateProjectV2FieldInput
 *   4. The user's existing projectsV2 (numbers, titles, ids)
 *   5. Reference project melodietexoss #1: fields (+ single-select options),
 *      views (+ layout/grouping), item counts — the "similar to this one" ask
 *
 * Usage: ANNOTAKIT_GH_TOKEN=... node scripts/gh-projects-recon.mjs
 */

const TOKEN = process.env.ANNOTAKIT_GH_TOKEN;
if (!TOKEN) {
  console.error('no token: set ANNOTAKIT_GH_TOKEN');
  process.exit(1);
}

const ENDPOINT = 'https://api.github.com/graphql';

async function gql(query, variables = {}) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'dom-annotakit-recon',
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status} non-JSON: ${text.slice(0, 300)}`);
  }
  if (json.errors) {
    return { ok: false, status: res.status, errors: json.errors, data: json.data };
  }
  return { ok: true, status: res.status, data: json.data };
}

const out = (label, value) => console.log(`\n=== ${label} ===\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`);

/* 1. viewer */
const viewer = await gql(`query { viewer { login name } }`);
out('1. viewer', viewer);
if (!viewer.ok) process.exit(1);

/* 2. Mutation surface */
const mut = await gql(`query {
  __type(name: "Mutation") {
    fields(includeDeprecated: true) { name }
  }
}`);
if (mut.ok) {
  const names = mut.data.__type.fields.map((f) => f.name).filter((n) => n.includes('rojectV2'));
  out('2. ProjectV2 mutations', names);
} else {
  out('2. Mutation introspect FAILED', mut);
}

/* 3. Input shapes */
const INPUT_TYPES = ['CreateProjectV2Input', 'CreateProjectV2FieldInput', 'AddProjectV2DraftIssueInput', 'UpdateProjectV2DraftIssueInput', 'UpdateProjectV2ItemFieldValueInput', 'UpdateProjectV2FieldInput', 'ProjectV2FieldValue'];
for (const t of INPUT_TYPES) {
  const q = await gql(`query { __type(name: "${t}") { name inputFields { name type { kind name ofType { kind name } } } } }`);
  out(`3. ${t}`, q.ok ? { name: q.data.__type.name, fields: q.data.__type.inputFields } : q.errors);
}

/* 3b: single-select option input */
const optType = await gql(`query { __type(name: "ProjectV2SingleSelectFieldOptionInput") { name inputFields { name } } }`);
out('3b. ProjectV2SingleSelectFieldOptionInput', optType);

/* 4. user projects */
const projects = await gql(`query { viewer { projectsV2(first: 20) { nodes { id number title url closed } } } }`);
out('4. viewer projectsV2', projects.ok ? projects.data.viewer.projectsV2.nodes : projects);

/* 5. reference project #1 */
const ref = await gql(`query($login: String!) {
  user(login: $login) {
    projectV2(number: 1) {
      id number title shortDescription url closed
      fields(first: 30) {
        totalCount
        nodes {
          __typename
          ... on ProjectV2FieldCommon { id name dataType }
          ... on ProjectV2SingleSelectField { options { id name color description } }
        }
      }
      views(first: 10) { nodes { id name layout grouping { fieldId } } }
      items(first: 1) { totalCount }
    }
  }
}`, { login: 'melodietexoss' });
out('5. melodietexoss project #1', ref.ok ? ref.data.user.projectV2 : ref);
