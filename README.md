# DevOps

GitHub 기반 AI Agent 개발 흐름(이슈 #1) 설계 및 검증용 저장소입니다.

## 포함 항목

- [docs/github-ai-agent-dev-flow.md](docs/github-ai-agent-dev-flow.md): 이슈 생성부터 Merge Decision까지의 설계서
- [pipeline/agent-flow.json](pipeline/agent-flow.json): 기계가 읽을 수 있는 파이프라인 정의
- [scripts/validate_agent_flow.py](scripts/validate_agent_flow.py): 파이프라인 정의 검증 스크립트
- [.github/workflows/agent-flow-check.yml](.github/workflows/agent-flow-check.yml): PR 시 파이프라인 정의 정적 검증

## 로컬 검증

```bash
python scripts/validate_agent_flow.py
```
