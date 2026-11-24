import pytest
from ma_core.wire import entry_in, entry_out
from ma_history.portable import session_view
from ma_history.profile import discover
from ma_history.service import tombstone


@pytest.mark.parametrize(
    ("kind", "field", "payload"),
    [
        ("inputAccepted", "inputId", {"inputId": "nested"}),
        ("inputHandedBack", "inputId", {"inputIds": ["nested"]}),
        ("inputRequest", "requestId", {"request": {"id": "nested"}}),
        ("inputAnswer", "requestId", {"requestId": "nested"}),
        ("turnStart", "continuesTurnId", {"continuesTurnId": "nested"}),
    ],
)
def test_tombstone_only_keeps_envelope_association(kind, field, payload):
    base = {"id": "entry", "parentId": None, "kind": kind}
    live = {**base, "data": payload, "inputIds": ["plural"]}
    erased = {**base, "erased": True}
    assert tombstone(live) == erased
    assert tombstone({**live, field: "envelope"}) == {**erased, field: "envelope"}
    assert entry_out(entry_in({**erased, field: "envelope"}, "session")) == {
        **erased,
        field: "envelope",
    }


def test_erasure_copy_discovery_links_only_enveloped_inputs():
    entries = [
        {"id": "accepted", "kind": "inputAccepted", "inputId": "one"},
        {"id": "legacy", "kind": "inputHandedBack", "inputIds": ["one"]},
        {"id": "taken", "kind": "input", "inputId": "one"},
        {"id": "nested", "kind": "input", "data": {"inputId": "one"}},
        {"id": "hand-back", "kind": "inputHandedBack", "inputId": "one", "inputIds": ["other"]},
    ]
    assert set(discover({"session": ({}, entries)}, "session", ["accepted"])["session"]) == {
        "accepted",
        "taken",
        "hand-back",
    }


def test_portable_view_projects_envelope_identities_through_erasure():
    live = {
        "id": "input",
        "parentId": None,
        "kind": "inputHandedBack",
        "inputId": "admission",
        "data": {"inputIds": ["nested"]},
    }
    marker = {"id": "erase", "kind": "erasure", "data": {"entryIds": ["input"]}}
    session = session_view({"id": "session"}, [live, marker])
    assert entry_out(session["entries"][0]) == {
        "id": "input",
        "parentId": None,
        "kind": "inputHandedBack",
        "erased": True,
        "inputId": "admission",
    }


def test_portable_answer_reads_the_envelope_and_does_not_repeat_its_id():
    native = entry_in(
        {
            "id": "answer",
            "kind": "inputAnswer",
            "requestId": "envelope",
            "data": {"requestId": "nested", "value": "yes"},
        },
        "session",
    )
    assert native["data"]["request"] == "envelope"
    wire = entry_out(native)
    assert wire["requestId"] == "envelope"
    assert "requestId" not in wire["data"]
