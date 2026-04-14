# GitHub 기반 AI Agent 개발 흐름 설계서

이 문서는 `Issue 생성 -> PR Review`까지 AI Agent가 개입하는 자동화 파이프라인의 기준 설계를 정의합니다.

## 목표

- 이슈 생성 시 자동 triage
- 개발 착수 전 명시적 승인 게이트
- 코딩/리뷰/머지 준비를 상태 기반으로 추적
- 각 단계 산출물(artifact)과 실행 이력(agent run) 기록

## End-to-End 시나리오

1. `Issue Opened`
2. `Issue Triage Agent`가 이슈를 분류하고 우선순위를 부여
3. `Branch + Scaffold`를 생성하고 Work Item을 `TRIAGED -> PLANNED`로 전이
4. 사람/시스템 승인 후 `APPROVED_FOR_DEV`
5. `Coding Agent`가 코드 변경/커밋/푸시/PR 초안 생성
6. `Code Review Agent`가 정적 검토 및 정책 위반 여부 판단
7. `Merge Decision Agent`가 최종 게이트(승인/체크) 충족 여부를 판정

## 상태 모델

- `OPEN`
- `TRIAGED`
- `PLANNED`
- `APPROVED_FOR_DEV`
- `IN_PROGRESS`
- `DRAFT_PR`
- `VALIDATING`
- `REVIEWING`
- `REVIEW_PASSED`
- `MERGE_READY`
- `MERGED`
- `CHANGES_REQUESTED`
- `HUMAN_REQUIRED`
- `QUARANTINED`
- `CANCELLED`

## 승인 게이트

- `PLANNED -> APPROVED_FOR_DEV`: `plan` 승인 필요
- `REVIEW_PASSED -> MERGE_READY`: `merge` 승인 필요

## 책임 분리

- Triage: 이슈 정규화/라벨링/초기 위험도 판단
- Coding: 구현 및 변경셋 생성
- Review: 코드 품질/정책/회귀 위험 검증
- Merge Decision: 병합 가능성 판정과 차단 사유 명시

## 산출물(Artifact)

- Triage summary
- Planning document
- Patch/commit metadata
- Validation report
- Review findings
- Merge readiness report

## 운영 가드레일

- 예산 제한: 실행 시간, 변경 파일 수, LOC, LLM 호출 횟수
- 정책 차단: 민감 경로 변경, 미승인 머지, 검증 실패
- 이력 보존: 상태 전이 로그, 승인 이벤트 원장, agent run 메타데이터
