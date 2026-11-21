---
status: proposed
---

# Close the remaining production gaps

[ADR 0021](0021-production-edition.md) left four gaps. Secret staging and recovery are now specified under [Secrets](../contracts.md#secrets) and shipped in all four SDKs. This record proposes rules for the other three. It does not change the edition to pin or claim implementation coverage.

## Per-connection isolation

[ADR 0029](0029-sdk-decisions-after-four-builds.md) settled ACP service token scope and the rights ceiling, not stdio policy, configured representation, or isolation of plugin and history services. ACP already requires project and tenant checks; it does not specify the cutoff for attached work and deliveries or the operator API for representation. The plugin service already promises separate instances and named state, but does not specify which state must be connection-local or how host-supplied paths are bounded. History `/1` already gives every credential full raw access; the deployment must partition the storage, not just front it with different tokens.

[Authority](../contracts.md#authority), [ACP](../bindings/acp.md#authorization) and the [SDK serving options](../sdk/api.md#the-agent) specify these boundaries. [WebSocket](../bindings/websocket.md#a-plugin-service) separates a live plugin instance from retained state and trusted storage. [History HTTP](../bindings/history-http.md#the-basics) keeps its existing trust model. Joining does not confer representation; using a joined actor as the caller's identity would let `grant` change authentication. A mutable plugin instance shared by live connections would make callbacks and cancellation ambiguous. Neither tenant metadata nor a project filter is a raw-history security boundary.

### Isolation checks

- **ACP kit and reference check, both transports:** configure two projects (one nested in the other), two tenants plus no tenant, and one recorded actor with larger grants than the connection ceiling. Test exact paths through symlinks, empty scopes, configured no-tenant access and omitted scope. Probe new, list (including borrowed cursors), load/resume with supplied and stored project mismatches, and fork. Use counters to prove forbidden opens do not call project setup or load MCP. Check that unknown and inaccessible IDs produce the same refusal and that grants are unchanged after a narrow connection opens.
- **ACP kit, multiple connections:** test history, input, cancellation, questions, updates and withheld or queued replies on a narrowed scope or a detached connection. Pause before dispatch and before delivery, then revoke the required access; check no effect or disclosure. Repeat through a nested callback, child or job report and after reopen to verify stored work ceilings. Join an unrepresented actor and try its ID in `input` and `answer`; expect `forbidden`, no presence and no admission. On an authorized route verify the two identities in history, negative acknowledgements for stale questions, the intersection of rights, and that closing one route leaves membership and another eligible route intact. Try malformed operator options and assert startup fails. Run the supported subset against `ma`, which does not declare several actors.
- **Plugin kit, service mode:** connect two hosts with the same request, session and job IDs and `home` but distinct credentials and project grants. Run overlapping work, cancel and close one connection, and check that callbacks, results, cleanup and retained state do not cross. Reconnect and check that only that host's retained state is available. A working environment must deny another host's project or point on initialize or operation as applicable. Include a same-credential pair to check connection-local work even within one trust scope.
- **History kit, deployment check:** launch two services with separate credentials and backing namespaces. A credential is rejected on the other service (`401 unauthorized`); listing and direct lookup in the first cannot see a session seeded only in the second. Try acquire, append and erase against the foreign ID in the first and verify `unknown_session` and unchanged records in the second. Check that trusted routing selects the correct store regardless of client-supplied IDs or project settings.

### Open isolation decisions

- **CLI policy:** a shared operator-owned policy file or separate flags and environment variables. Recommend one file for stdio and WebSocket; keep the existing local shorthand and fail startup on invalid policy. The SDK options do not depend on that format.
- **Stateful plugin provisioning:** separate listeners or a shared listener with distinct host credentials and operator-assigned state and project scopes. Recommend separate listeners until there is a common hosting API that proves the same isolation. `/1` history stays on separate service instances; a multi-tenant raw service would need a separate binding decision.
