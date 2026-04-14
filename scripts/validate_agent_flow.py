import json
import pathlib
import sys


ROOT = pathlib.Path(__file__).resolve().parents[1]
FLOW_PATH = ROOT / "pipeline" / "agent-flow.json"


def fail(message: str) -> None:
    print(f"[FAIL] {message}")
    sys.exit(1)


def main() -> None:
    if not FLOW_PATH.exists():
        fail(f"flow definition not found: {FLOW_PATH}")

    data = json.loads(FLOW_PATH.read_text(encoding="utf-8"))

    states = data.get("states")
    if not isinstance(states, list) or not states:
        fail("states must be a non-empty array")
    state_set = set(states)

    transitions = data.get("transitions")
    if not isinstance(transitions, list) or not transitions:
        fail("transitions must be a non-empty array")

    sources = set()
    for idx, tr in enumerate(transitions):
        if not isinstance(tr, dict):
            fail(f"transition[{idx}] must be an object")
        src = tr.get("from")
        dst = tr.get("to")
        if src not in state_set:
            fail(f"transition[{idx}] source not in states: {src}")
        if not isinstance(dst, list):
            fail(f"transition[{idx}] to must be an array")
        for d in dst:
            if d not in state_set:
                fail(f"transition[{idx}] target not in states: {d}")
        sources.add(src)

    missing_sources = [s for s in states if s not in sources]
    if missing_sources:
        fail(f"missing transition definitions for states: {missing_sources}")

    gates = data.get("gates", [])
    if not isinstance(gates, list):
        fail("gates must be an array")
    for idx, gate in enumerate(gates):
        if not isinstance(gate, dict):
            fail(f"gate[{idx}] must be an object")
        for field in ["name", "required_for_transition", "approval_subject", "required_action"]:
            if field not in gate:
                fail(f"gate[{idx}] missing field: {field}")

    agents = data.get("agents", [])
    if not isinstance(agents, list) or not agents:
        fail("agents must be a non-empty array")
    for idx, agent in enumerate(agents):
        if not isinstance(agent, dict):
            fail(f"agent[{idx}] must be an object")
        for field in ["name", "trigger", "input", "output", "default_transition"]:
            if field not in agent:
                fail(f"agent[{idx}] missing field: {field}")

        default_transition = agent["default_transition"]
        if not isinstance(default_transition, dict):
            fail(f"agent[{idx}] default_transition must be an object")
        src = default_transition.get("from")
        dst = default_transition.get("to")
        if src not in state_set or dst not in state_set:
            fail(f"agent[{idx}] default_transition has unknown state: {src}->{dst}")

    print("[OK] agent flow definition is valid")


if __name__ == "__main__":
    main()
