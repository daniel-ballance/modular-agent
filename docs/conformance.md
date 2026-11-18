# Conformance and versioning

This document defines conformance for agents, plugins, services and hosts, and how the bindings change. Core behavior, trust and wire rules are in the documents below.

## The documents

| Normative document | Holds |
|---|---|
| This document | Conformance, keywords and versioning |
| [Contracts](contracts.md) | Core behavior, independent of transport |
| [Security](security.md) | Trust boundaries and their enforcement |
| [Shared data](bindings/data.md) | JSON shapes and portable sessions |
| [Plugin binding](bindings/plugin.md) | Plugins in another process, in any language |
| [ACP binding](bindings/acp.md) | Driving an agent over ACP |
| [History service binding](bindings/history-http.md) | A history store as an HTTP service |

Informative documents explain and illustrate. Where one disagrees with a normative document, the normative document wins. A binding can specify a narrower profile or an explicit mapping of core behavior. It does not silently override a core rule. Unresolved conflicts between applicable rules are defects.

| Informative document | Holds |
|---|---|
| [README](../README.md) | Reading order and production acceptance |
| [Glossary](../GLOSSARY.md) | Vocabulary |
| [Implementer's guide](implementers-guide.md) | Build order, a turn walked through end to end, what goes wrong, and which kit checks each part |
| [Architecture](architecture.md) | Parts, responsibilities and design |
| [Scenarios](scenarios.md) | Worked examples |
| [Bindings index](bindings/README.md) | Map of the wire profiles |
| [Decision records](adr/README.md) | The reasons for past decisions |
| [Open questions](open-questions.md) | Limits and implementation choices, with safe defaults |
| [Conformance kits](../conformance/) | Programs that check parts of the bindings |
| Research, pressure tests, examples, build notes, and build status | Background and implementation evidence |

## Keywords

The capitalized keywords have their [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) meanings:

- **MUST**, **MUST NOT**: an absolute requirement.
- **SHOULD**, **SHOULD NOT**: a requirement that can be departed from only after weighing the consequences for the particular case.
- **MAY**: an option, not a requirement to implement it.

A build MUST document each departure from a recommendation and its reason. A peer MUST handle the documented fallback for an optional feature it does not get.

Lowercase words carry their ordinary meanings. Examples do not create requirements. Contracts defines the core types, operations and hook signatures before [Rules every implementation follows](contracts.md#rules-every-implementation-follows). Those definitions give the rules their meaning and scope.

## What conforms

### An agent

An agent MUST follow the applicable rules in [Contracts](contracts.md) and [Security](security.md), including the [declaration rules](contracts.md#declaration-rules). It MUST implement the specified fallback for any feature it does not support.

An agent MAY conform without any binding. A single-process agent with local history is one example. The core prescribes no transport. An agent MUST follow each binding it claims, including any shared data rules it uses. The core and each binding give the required behavior and identify optional features; support for one optional feature does not imply support for another.

### A plugin, a service or a host

A component claiming a role MUST follow the rules for that side of the connection and the applicable shared data rules. It MUST declare its supported options and implement their fallbacks. A role without applicable kit checks does not have to pass the opposite role's kit as that role.

| Binding | Role | Coverage |
|---|---|---|
| [ACP](bindings/acp.md) | Agent | ACP kit, including checks for declared features |
| [ACP](bindings/acp.md) | Client host | No standalone client kit |
| [Plugin](bindings/plugin.md) | Plugin | Plugin kit for its registered roles |
| [Plugin](bindings/plugin.md) | Host | Plugin-host probes driven through the ACP kit where applicable |
| [History HTTP](bindings/history-http.md) | Service | History kit |
| [History HTTP](bindings/history-http.md) | Client | History-backed agent checks in the ACP kit where applicable; no standalone client kit |

### The conformance kits

A build that claims a binding MUST pass the applicable checks in that binding's kit, where one exists. The kits need no real model. The history kit calls the service over HTTP. Shared data is exercised by the other kits, not by a separate kit.

| Kit | Checks | Run from kit directory |
|---|---|---|
| [ACP](../conformance/acp/README.md) | An agent, including checks for declared features | `node run.mjs [options] -- <agent command>` |
| [Plugin](../conformance/plugin/README.md) | A plugin program, with the kit as its host | `node run.mjs -- <plugin command>` |
| [History](../conformance/history/README.md) | A history service | `node run.mjs <url> <token file>` |

Passing a kit does not prove all requirements. Cross-build swaps test behavior that a kit run alone cannot show. Neither the kits nor the swaps certify a production security profile. Kit runs use disposable test data and credentials, not production ones.

## Versioning

Each binding has a name and a major version, such as `modular-agent-plugin/1`. A peer MUST establish the binding version before using its operations, through the mechanism in that binding:

- **ACP:** `initialize` selects `/1` by default, or `/2` when requested ([Versions](bindings/acp.md#versions)).
- **Plugin:** `plugin/initialize` names the plugin binding and shared data version ([Starting: the handshake](bindings/plugin.md#starting-the-handshake)).
- **History service:** `GET /v1` reports the binding ([What the service declares](bindings/history-http.md#what-the-service-declares)).

A peer MUST refuse to proceed if a required version or feature is unavailable. A build MAY support several major versions. A conformance claim MUST identify the specification revision used for acceptance as well as the claimed binding versions. Major versions alone do not identify the historical snapshots before this edition.

Within a major version, changes MUST preserve interoperability with existing conforming peers. Compatible changes include:

- An optional field that older receivers can preserve as inert data under the [shared data rules](bindings/data.md#general-rules).
- An optional extension method, request or entry kind offered only when declared or registered.
- An error code for a case that was previously undefined, where existing peers can still handle the response.
- A clarification that does not change how conforming builds behave.

An incompatible change MUST use a new major version. Examples include removing or renaming a field, changing its type or meaning, making an optional field required, or changing a default.

**This edition.** The bindings keep their current major versions. Their Changes sections record the rounds that led here; these entries are historical, not alternative rules. The compatibility rules above apply from this edition onward.

## Reporting a defect

A useful defect report gives the document and section, the exact text, what can go wrong and a proposed fix. A change to a binding MUST add an entry to its Changes section. A fix SHOULD add a regression check where an applicable kit can exercise the behavior.
