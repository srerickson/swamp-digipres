---
name: premis
description: Guide for developing a PREMIS 3.0 (preservation metadata) implementation. Use when designing, implementing, or reviewing data models, code, or serializations that produce, consume, or validate PREMIS metadata — objects, events, agents, rights, fixity, formats, provenance, preservation repositories.
---

# PREMIS 3.0 Implementation Guide

PREMIS (Preservation Metadata: Implementation Strategies) is the de facto standard
for metadata that supports digital preservation: proving objects are intact
(fixity), renderable (format, environment), authentic (provenance via events and
agents), and usable (rights). This skill guides implementation decisions and tells
you how to look up authoritative answers in the local copies of the spec.

## Authoritative resources in this repo

| File | What it is | Use it for |
|------|-----------|------------|
| `.claude/skills/premis/references/premis-hierarchical-3-0.md` | Complete outline of every semantic unit with number, mandatory/optional, repeatable/not, and applicable object categories | Fast lookup of structure, obligation, repeatability |
| `.claude/skills/premis/references/premis-3-0-datadictionary-only.pdf` | Full Data Dictionary (226 pp.) — the normative definition of every semantic unit | Definitions, rationale, data constraints, creation/maintenance notes, usage examples |
| `.claude/skills/premis/references/premis-v3-0.xsd` | Official XML schema, namespace `http://www.loc.gov/premis/v3` | XML serialization details, element order, attributes |

### Looking up a semantic unit in the Data Dictionary PDF

PDF page numbers match the printed page numbers. Section starts:

- Object entity: p. 11 (semantic units from p. 12)
- Event entity: p. 115
- Agent entity: p. 137
- Rights entity: p. 156

Each unit's entry gives: definition, rationale, data constraint, applicable object
categories, obligation, repeatability, creation/maintenance notes, and usage notes.
To find a unit's page, search the extracted text, then Read those pages:

```bash
pdftotext .claude/skills/premis/references/premis-3-0-datadictionary-only.pdf /tmp/dd.txt
grep -n "1.5.2 fixity" /tmp/dd.txt   # unit numbers come from the hierarchical listing
```

Or use the Read tool with `pages` on the PDF directly once you know the page range.
Always consult the Data Dictionary before making semantic claims — the hierarchical
listing gives structure only, not meaning.

### Known errata in the Data Dictionary

Official errata sheet: <https://www.loc.gov/standards/premis/v3/premis-3-0-errata.html>
(last updated 2017-04-25). One erratum affects the local excerpt:

- **4.1.8.3 `linkingObjectRole` (Rights entity, local PDF p. 221):** the printed
  definition and rationale say "in relation to an Agent" — this is wrong. Read
  both as "in relation to a **Right**" (the role of the object associated with a
  Rights statement).

The other errata correct the full document's introductory pages (a typo naming
`eventOutcomeDetail` where `eventDetailInformation` was meant, and a note that
the `relationshipSubType` value list is maintained at
`http://id.loc.gov/vocabulary/preservation/relationshipSubType.html`), which are
not part of the local excerpt.

## The data model

Four entities, linked by identifiers:

- **Object** — what is preserved. Every Object has exactly one `objectCategory`:
  - **Intellectual Entity** — a conceptual unit (a book, a website, a database).
    Since 3.0, environments (software, hardware) are also described as
    Intellectual Entities rather than a separate Environment entity.
  - **Representation** — the set of files needed to render one Intellectual Entity.
  - **File** — a named, ordered sequence of bytes known to an OS.
  - **Bitstream** — data within a file that needs its own technical description
    (e.g., a video stream inside a container).
- **Event** — an action involving at least one Object or Agent (ingest, fixity
  check, migration, validation…). Events are the provenance/audit trail.
- **Agent** — person, organization, or software associated with Events or Rights.
- **Rights** — assertions of rights and the acts a repository is permitted to take.

Entities never nest; they reference each other through identifier links
(`linkingObjectIdentifier`, `linkingEventIdentifier`, `linkingAgentIdentifier`,
`linkingRightsStatementIdentifier`, and Object-to-Object `relationship` with
`relatedObjectIdentifier`).

### Minimum mandatory core

| Entity | Mandatory semantic units |
|--------|--------------------------|
| Object | `objectIdentifier`, `objectCategory`, `objectCharacteristics` (File/Bitstream only, which makes `format` mandatory too) |
| Event | `eventIdentifier`, `eventType`, `eventDateTime` |
| Agent | `agentIdentifier` |
| Rights | nothing at top level; within a `rightsStatement`: `rightsStatementIdentifier`, `rightsBasis` |

Mandatory means: if the entity is described at all, the unit must be present.
Mandatory sub-units of an *optional* container only apply when the container is
used (e.g., `fixity` is optional, but if present, `messageDigestAlgorithm` and
`messageDigest` are required).

### Applicability by object category

Many Object units apply only to certain categories — the bracketed lists in the
hierarchical listing. Key ones:

- `objectCharacteristics` (fixity, size, format, creatingApplication, inhibitors):
  File and Bitstream only.
- `preservationLevel`, `originalName`: not applicable to Bitstream.
- `storage`, `signatureInformation`: not for Intellectual Entities.
- `environmentFunction` / `environmentDesignation` / `environmentRegistry`: only
  for Intellectual Entities that *are* environments.

An implementation should enforce these — the XSD does (each category is a
distinct complex type), but non-XML implementations must do it themselves.

## Implementation guidance

### Conformance is to the Data Dictionary, not the XML schema

PREMIS is serialization-independent. You may store preservation metadata in a
relational DB, RDF, JSON, or anything else; conformance means your data can be
mapped to the semantic units without loss of meaning, mandatory units are
present, and you don't redefine unit semantics. The XSD is one binding, commonly
used for exchange and for embedding in METS. Design your internal model against
the Data Dictionary; treat XML as an export format.

### Decisions to make early

1. **Which entities you implement.** Object + Event is the practical minimum for
   a preservation system; Agents usually follow immediately (who/what performed
   each event). Rights is often phased in later.
2. **Which object categories you support.** Many repositories start with File
   (+ Representation for multi-file works). Bitstream is only needed when
   sub-file technical metadata matters.
3. **Identifier scheme.** Every identifier is a (type, value) pair, and every
   link between entities depends on them. Identifiers must be unique within the
   repository and stable. Decide the `*IdentifierType` values (e.g., UUID, local,
   ARK) up front and use them consistently.
4. **Which events to record.** Rule from the spec: actions that *modify* an
   object must always be recorded. Beyond that, typical set: ingestion,
   validation, fixity check, virus check, format identification, migration,
   normalization, replication, deletion. Record failures as well as successes
   (`eventOutcome`).
5. **Controlled vocabularies.** Many units expect values from controlled lists.
   Prefer the Library of Congress preservation vocabularies at
   `http://id.loc.gov/vocabulary/preservation/` (eventType, agentType,
   relationshipType/subType, preservationLevelRole, etc.). For formats, prefer
   PRONOM: `formatRegistryName="PRONOM"`, `formatRegistryKey` = PUID (e.g.,
   `fmt/43`); record `formatName`/`formatVersion` alongside.
6. **Granularity of description.** PREMIS allows describing at IE,
   Representation, File, and Bitstream levels; you don't need all of them.
   Pick the levels your preservation actions actually operate on.

### Modeling patterns

- **Structural links:** a Representation links to its Files with
  `relationship` (`relationshipType="structural"`, subtype e.g. "has part"/"is
  part of"); use `relatedObjectSequence` when order matters.
- **Derivation/provenance chain:** migration produces a new Object; link old and
  new with a derivation relationship *and* link both to the migration Event
  (`relatedEventIdentifier` on the relationship, or `linkingEventIdentifier`).
  The Event's `linkingObjectIdentifier` should use `linkingObjectRole` (source/
  outcome) to disambiguate.
- **Events are immutable.** They are an audit trail: never update or delete a
  recorded event; record a new one.
- **Fixity:** store algorithm + digest per File/Bitstream; each fixity *check*
  is an Event with an outcome. Multiple `fixity` units (different algorithms)
  are allowed and common.
- **Environments (3.0):** software/hardware needed to render objects are
  themselves Objects (Intellectual Entities with `environmentFunction` etc.),
  linked from content objects via `relationship` with
  `relatedEnvironmentPurpose`. Don't use the pre-3.0 embedded `environment`
  container — it was removed.
- **Extensions:** every `*Extension` unit is an escape hatch for
  metadata PREMIS doesn't model (e.g., MIX inside
  `objectCharacteristicsExtension`, tool output inside
  `eventOutcomeDetailExtension`). Use them rather than overloading note fields.
- **Business rules are out of scope.** Retention schedules, costs, repository
  policy, descriptive metadata: PREMIS deliberately excludes these
  (see pp. 9–10, "Limits to the scope"). Model them outside your PREMIS core.

### XML serialization notes (when using the XSD)

- Namespace is `http://www.loc.gov/premis/v3` (changed from the v2
  `info:lc/xmlns/premis-v2`). Add `version="3.0"` on the root.
- Root element: `<premis>` container holding one or more entities, or a single
  `<object>`, `<event>`, `<agent>`, or `<rights>` standalone.
- `objectComplexType` is abstract: an `<object>` must carry
  `xsi:type="premis:file"`, `premis:representation`, `premis:bitstream`, or
  `premis:intellectualEntity` (new in 3.0). The xsi:type *is* the
  objectCategory in XML.
- Dates use EDTF conventions; the schema types them as plain strings, so
  validate date formats in application code.
- Removed/renamed in 3.0 (watch for stale v2 examples online): `mdSec` removed,
  `<environment>` removed, `eventDetail` → structured `eventDetailInformation`,
  `relatedObjectIdentification` → `relatedObjectIdentifier`,
  `linkingIntellectualEntityIdentifier` removed.
- Validate exports:
  `xmllint --noout --schema .claude/skills/premis/references/premis-v3-0.xsd instance.xml`

### Review checklist for a PREMIS implementation

- [ ] Every described entity carries its mandatory units (table above).
- [ ] Identifier (type, value) pairs are consistent and every link resolves.
- [ ] Category-restricted units are only used on applicable object categories.
- [ ] Repeatability constraints respected (NR units appear at most once).
- [ ] Object-modifying actions always produce an Event; events link the agent
      that performed them and the objects involved (with roles).
- [ ] Controlled vocabulary values come from a documented source (LoC
      vocabularies, PRONOM) rather than free text.
- [ ] Semantics match the Data Dictionary — when in doubt, read the unit's
      entry in the PDF rather than inferring from the unit's name.
