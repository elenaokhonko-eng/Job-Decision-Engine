/**
 * Stage 1 Capability Profile Facts Builder
 * Constructs and validates the comprehensive Stage 1 facts dataset.
 */

import * as fs from 'fs';
import * as path from 'path';
import { FactJsonSchema, type FactType, type ExperienceClass, type VerificationStatus, type Confidentiality } from '../src/profile/contracts.js';

interface FactInput {
  fact_key: string;
  engagement_key?: string;
  fact_type: FactType;
  statement: string;
  structured_value: Record<string, unknown>;
  evidence_tier: ExperienceClass;
  verification_status: VerificationStatus;
  start_date?: string;
  end_date?: string;
  is_current: boolean;
  confidentiality: Confidentiality;
  evidence_source_keys: string[];
}

export function buildStage1Facts(): FactInput[] {
  const facts: FactInput[] = [];

  function addFact(fact: FactInput) {
    facts.push(fact);
  }

  // ==========================================================================
  // 1. SYSTEMS ARCHITECTURE
  // ==========================================================================
  addFact({
    fact_key: 'fact.arch.enterprise_architecture.institutional',
    engagement_key: 'aia.aiaim.enterprise_architect_program_lead',
    fact_type: 'SKILL',
    statement: 'Strong professional production capability in enterprise architecture across institutional investment management and multi-market enterprise environments.',
    structured_value: {
      capability_family: 'SYSTEMS_ARCHITECTURE',
      capability_name: 'enterprise_architecture',
      display_label: 'Enterprise Architecture',
      proficiency: 'ADVANCED',
      hands_on_level: 'PRODUCTION',
      interest: 'TARGET',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2023-04-01',
    end_date: '2025-04-30',
    is_current: false,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.profile'],
  });

  addFact({
    fact_key: 'fact.arch.application_architecture',
    engagement_key: 'guidebuoy.ai.founder_architect',
    fact_type: 'SKILL',
    statement: 'Strong hands-on application architecture capability, designing modular, decoupled backends and modern client application boundaries.',
    structured_value: {
      capability_family: 'SYSTEMS_ARCHITECTURE',
      capability_name: 'application_architecture',
      display_label: 'Application Architecture',
      proficiency: 'ADVANCED',
      hands_on_level: 'PRODUCTION',
      interest: 'TARGET',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2025-08-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.repo'],
  });

  addFact({
    fact_key: 'fact.arch.integration_api_architecture',
    engagement_key: 'guidebuoy.ai.founder_architect',
    fact_type: 'SKILL',
    statement: 'Strong integration and API architecture experience across REST services, event streams, microservices, and external vendor/custodian gateways.',
    structured_value: {
      capability_family: 'SYSTEMS_ARCHITECTURE',
      capability_name: 'integration_api_architecture',
      display_label: 'Integration & API Architecture',
      proficiency: 'ADVANCED',
      hands_on_level: 'PRODUCTION',
      interest: 'TARGET',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2025-08-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.repo', 'src.product'],
  });

  addFact({
    fact_key: 'fact.arch.data_architecture',
    engagement_key: 'aia.aiaim.enterprise_architect_program_lead',
    fact_type: 'SKILL',
    statement: 'Strong data architecture capability spanning relational schemas, time-series data, master data hubs, and vector stores.',
    structured_value: {
      capability_family: 'SYSTEMS_ARCHITECTURE',
      capability_name: 'data_architecture',
      display_label: 'Data Architecture',
      proficiency: 'ADVANCED',
      hands_on_level: 'PRODUCTION',
      interest: 'TARGET',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2023-04-01',
    end_date: '2025-04-30',
    is_current: false,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.profile'],
  });

  addFact({
    fact_key: 'fact.arch.target_operating_model',
    engagement_key: 'aia.aiaim.enterprise_architect_program_lead',
    fact_type: 'SKILL',
    statement: 'Proven expert in Target Operating Model (TOM) design and execution, evidenced by full institutional transformation and program rescue at AIAIM.',
    structured_value: {
      capability_family: 'SYSTEMS_ARCHITECTURE',
      capability_name: 'target_operating_model',
      display_label: 'Target Operating Model (TOM) Design',
      proficiency: 'EXPERT',
      hands_on_level: 'PRODUCTION',
      interest: 'TARGET',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'RECENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2023-04-01',
    end_date: '2025-04-30',
    is_current: false,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.profile'],
  });

  addFact({
    fact_key: 'fact.arch.ai_llm_solution_architecture',
    engagement_key: 'guidebuoy.ai.founder_architect',
    fact_type: 'SKILL',
    statement: 'Current applied and production startup evidence architecting end-to-end AI/LLM solutions, agentic orchestration, and neuro-symbolic guardrails.',
    structured_value: {
      capability_family: 'SYSTEMS_ARCHITECTURE',
      capability_name: 'ai_llm_solution_architecture',
      display_label: 'AI / LLM Solution Architecture',
      proficiency: 'ADVANCED',
      hands_on_level: 'PRODUCTION',
      interest: 'TARGET',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2025-08-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.product', 'src.repo'],
  });

  addFact({
    fact_key: 'fact.arch.cloud_architecture.developing',
    fact_type: 'SKILL',
    statement: 'Conceptual and developing cloud architecture knowledge across GCP and AWS; actively pursuing Google Cloud Architect certification.',
    structured_value: {
      capability_family: 'SYSTEMS_ARCHITECTURE',
      capability_name: 'cloud_architecture',
      display_label: 'Cloud Architecture',
      proficiency: 'FOUNDATIONAL',
      hands_on_level: 'CONCEPTUAL',
      interest: 'STRONG',
      evidence_strength: 'KNOWLEDGE_ONLY',
      recency: 'CURRENT',
      development_status: 'DEVELOPING',
      notes: 'Developing / studying towards Google Professional Cloud Architect; not yet production-proven.',
    },
    evidence_tier: 'KNOWLEDGE_ONLY',
    verification_status: 'SELF_ATTESTED',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.interview.stage1'],
  });

  addFact({
    fact_key: 'fact.arch.security_architecture.supporting',
    fact_type: 'SKILL',
    statement: 'Supporting knowledge of enterprise security architecture, identity controls, and compliance boundaries; not a target standalone specialization.',
    structured_value: {
      capability_family: 'SYSTEMS_ARCHITECTURE',
      capability_name: 'security_architecture',
      display_label: 'Security Architecture',
      proficiency: 'FOUNDATIONAL',
      hands_on_level: 'CONCEPTUAL',
      interest: 'SUPPORTING',
      evidence_strength: 'KNOWLEDGE_ONLY',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'KNOWLEDGE_ONLY',
    verification_status: 'SELF_ATTESTED',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.interview.stage1'],
  });

  // ==========================================================================
  // 2. HANDS-ON SOFTWARE ENGINEERING
  // ==========================================================================
  addFact({
    fact_key: 'fact.swe.python.independent_usable',
    engagement_key: 'guidebuoy.ai.founder_architect',
    fact_type: 'TECHNOLOGY',
    statement: 'Python: independently usable and approaching production-capable with AI assistance; built automated verification, parsing, and analysis scripts.',
    structured_value: {
      capability_family: 'SOFTWARE_ENGINEERING',
      capability_name: 'python',
      display_label: 'Python Programming',
      proficiency: 'INDEPENDENT',
      hands_on_level: 'APPLIED_PROJECT',
      interest: 'STRONG',
      evidence_strength: 'APPLIED_PROJECT',
      recency: 'CURRENT',
      ai_assisted: true,
      development_status: 'CURRENT',
    },
    evidence_tier: 'APPLIED_PROJECT',
    verification_status: 'SELF_ATTESTED',
    start_date: '2025-08-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.repo'],
  });

  addFact({
    fact_key: 'fact.swe.typescript.independent_usable',
    fact_type: 'TECHNOLOGY',
    statement: 'TypeScript: independently usable and approaching production-capable with AI assistance; built backend contracts, runtime validations, and pipeline components.',
    structured_value: {
      capability_family: 'SOFTWARE_ENGINEERING',
      capability_name: 'typescript',
      display_label: 'TypeScript Programming',
      proficiency: 'INDEPENDENT',
      hands_on_level: 'APPLIED_PROJECT',
      interest: 'STRONG',
      evidence_strength: 'APPLIED_PROJECT',
      recency: 'CURRENT',
      ai_assisted: true,
      development_status: 'CURRENT',
    },
    evidence_tier: 'APPLIED_PROJECT',
    verification_status: 'SELF_ATTESTED',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.repo'],
  });

  addFact({
    fact_key: 'fact.swe.sql.independent_usable',
    engagement_key: 'aia.aiaim.enterprise_architect_program_lead',
    fact_type: 'TECHNOLOGY',
    statement: 'SQL: independently usable and production-tested across complex relational joins, aggregations, schema design, and reporting.',
    structured_value: {
      capability_family: 'SOFTWARE_ENGINEERING',
      capability_name: 'sql',
      display_label: 'SQL & Relational Databases',
      proficiency: 'INDEPENDENT',
      hands_on_level: 'PRODUCTION',
      interest: 'STRONG',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2023-04-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.profile'],
  });

  addFact({
    fact_key: 'fact.swe.fullstack_app_dev.applied',
    engagement_key: 'guidebuoy.ai.founder_architect',
    fact_type: 'SKILL',
    statement: 'Applied front-end and back-end application development with AI assistance; built responsive prototypes, dashboards, and API services.',
    structured_value: {
      capability_family: 'SOFTWARE_ENGINEERING',
      capability_name: 'fullstack_app_dev',
      display_label: 'Full-Stack Application Development',
      proficiency: 'INDEPENDENT',
      hands_on_level: 'APPLIED_PROJECT',
      interest: 'STRONG',
      evidence_strength: 'APPLIED_PROJECT',
      recency: 'CURRENT',
      ai_assisted: true,
      development_status: 'CURRENT',
    },
    evidence_tier: 'APPLIED_PROJECT',
    verification_status: 'SELF_ATTESTED',
    start_date: '2025-08-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.repo'],
  });

  addFact({
    fact_key: 'fact.swe.apis_microservices.applied',
    engagement_key: 'guidebuoy.ai.founder_architect',
    fact_type: 'SKILL',
    statement: 'Applied hands-on design and implementation of RESTful APIs, webhook ingestion, and service integrations.',
    structured_value: {
      capability_family: 'SOFTWARE_ENGINEERING',
      capability_name: 'apis_microservices',
      display_label: 'APIs & Microservices',
      proficiency: 'INDEPENDENT',
      hands_on_level: 'APPLIED_PROJECT',
      interest: 'STRONG',
      evidence_strength: 'APPLIED_PROJECT',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'APPLIED_PROJECT',
    verification_status: 'SELF_ATTESTED',
    start_date: '2025-08-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.repo'],
  });

  addFact({
    fact_key: 'fact.swe.neon_postgresql.hands_on',
    engagement_key: 'guidebuoy.ai.founder_architect',
    fact_type: 'TECHNOLOGY',
    statement: 'Neon Serverless PostgreSQL: hands-on applied experience with branching, pooled connections, pgvector, and automated schema migrations.',
    structured_value: {
      capability_family: 'SOFTWARE_ENGINEERING',
      capability_name: 'neon_postgresql',
      display_label: 'Neon PostgreSQL & Vector',
      proficiency: 'INDEPENDENT',
      hands_on_level: 'APPLIED_PROJECT',
      interest: 'TARGET',
      evidence_strength: 'APPLIED_PROJECT',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'APPLIED_PROJECT',
    verification_status: 'SELF_ATTESTED',
    start_date: '2025-08-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.repo'],
  });

  addFact({
    fact_key: 'fact.swe.supabase.hands_on',
    engagement_key: 'guidebuoy.ai.founder_architect',
    fact_type: 'TECHNOLOGY',
    statement: 'Supabase: applied hands-on experience using Postgres auth, storage, database triggers, and edge services.',
    structured_value: {
      capability_family: 'SOFTWARE_ENGINEERING',
      capability_name: 'supabase',
      display_label: 'Supabase Backend',
      proficiency: 'INDEPENDENT',
      hands_on_level: 'APPLIED_PROJECT',
      interest: 'STRONG',
      evidence_strength: 'APPLIED_PROJECT',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'APPLIED_PROJECT',
    verification_status: 'SELF_ATTESTED',
    start_date: '2025-08-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.repo'],
  });

  addFact({
    fact_key: 'fact.swe.cicd_automation.applied',
    fact_type: 'SKILL',
    statement: 'Applied hands-on CI/CD pipeline automation using GitHub Actions for testing, linting, migration verification, and release tagging.',
    structured_value: {
      capability_family: 'SOFTWARE_ENGINEERING',
      capability_name: 'cicd_automation',
      display_label: 'CI/CD & GitHub Actions',
      proficiency: 'INDEPENDENT',
      hands_on_level: 'APPLIED_PROJECT',
      interest: 'STRONG',
      evidence_strength: 'APPLIED_PROJECT',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'APPLIED_PROJECT',
    verification_status: 'SELF_ATTESTED',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.repo'],
  });

  addFact({
    fact_key: 'fact.swe.testing_qa.applied',
    fact_type: 'SKILL',
    statement: 'Applied hands-on automated testing experience with Vitest, unit suites, integration tests, and failure injection fixtures.',
    structured_value: {
      capability_family: 'SOFTWARE_ENGINEERING',
      capability_name: 'testing_qa',
      display_label: 'Automated Testing & QA',
      proficiency: 'INDEPENDENT',
      hands_on_level: 'APPLIED_PROJECT',
      interest: 'STRONG',
      evidence_strength: 'APPLIED_PROJECT',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'APPLIED_PROJECT',
    verification_status: 'SELF_ATTESTED',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.repo'],
  });

  addFact({
    fact_key: 'fact.swe.observability.learning',
    fact_type: 'SKILL',
    statement: 'Observability & monitoring: active learning in structured logging, tracing, metrics collection, and alerting.',
    structured_value: {
      capability_family: 'SOFTWARE_ENGINEERING',
      capability_name: 'observability',
      display_label: 'Observability & Monitoring',
      proficiency: 'LEARNING',
      hands_on_level: 'CONCEPTUAL',
      interest: 'SUPPORTING',
      evidence_strength: 'KNOWLEDGE_ONLY',
      recency: 'CURRENT',
      development_status: 'DEVELOPING',
    },
    evidence_tier: 'KNOWLEDGE_ONLY',
    verification_status: 'SELF_ATTESTED',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.interview.stage1'],
  });

  // ==========================================================================
  // 3. AI ENGINEERING & AGENTIC SYSTEMS
  // ==========================================================================
  addFact({
    fact_key: 'fact.cred.aws_ai_specialist',
    fact_type: 'SKILL',
    statement: 'Candidate reports earning the AWS Certified AI Specialist certificate as part of the sponsored NTU Data Science and AI paid certificate programme.',
    structured_value: {
      capability_family: 'AI_ENGINEERING',
      capability_name: 'aws_ai_specialist',
      display_label: 'AWS Certified AI Specialist',
      proficiency: 'FOUNDATIONAL',
      hands_on_level: 'COURSE_PROJECT',
      interest: 'TARGET',
      evidence_strength: 'COURSE_PROJECT',
      recency: 'CURRENT',
      development_status: 'CURRENT',
      notes: 'Credential confirmed by candidate; course provenance recorded. Do not infer production engineering experience or an issue date.',
    },
    evidence_tier: 'COURSE_PROJECT',
    verification_status: 'SELF_ATTESTED',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.ntu.aws_ai_specialist'],
  });

  addFact({
    fact_key: 'fact.ai.rag_architectures.hands_on',
    engagement_key: 'guidebuoy.ai.founder_architect',
    fact_type: 'SKILL',
    statement: 'Hands-on production architecture and deployment of multi-stage RAG pipelines, contextual chunking, dense embeddings, and metadata-filtered retrieval.',
    structured_value: {
      capability_family: 'AI_ENGINEERING',
      capability_name: 'rag_architectures',
      display_label: 'RAG Architectures',
      proficiency: 'ADVANCED',
      hands_on_level: 'PRODUCTION',
      interest: 'TARGET',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2025-08-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.product', 'src.repo'],
  });

  addFact({
    fact_key: 'fact.ai.agents_multiagent_swarms.hands_on',
    engagement_key: 'audhd.research_lab.founder',
    fact_type: 'SKILL',
    statement: 'Hands-on design and implementation of autonomous agents and multi-agent swarms for complex research synthesis and dispute handling.',
    structured_value: {
      capability_family: 'AI_ENGINEERING',
      capability_name: 'agents_multiagent_swarms',
      display_label: 'Agents & Multi-Agent Swarms',
      proficiency: 'ADVANCED',
      hands_on_level: 'PRODUCTION',
      interest: 'TARGET',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2026-05-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.repo'],
  });

  addFact({
    fact_key: 'fact.ai.agentic_orchestration.hands_on',
    engagement_key: 'guidebuoy.ai.founder_architect',
    fact_type: 'SKILL',
    statement: 'Current hands-on agentic orchestration: supervisor-worker workflows, state-machine transitions, tool dispatch, and deterministic verification gates.',
    structured_value: {
      capability_family: 'AI_ENGINEERING',
      capability_name: 'agentic_orchestration',
      display_label: 'Agentic Orchestration & Workflows',
      proficiency: 'ADVANCED',
      hands_on_level: 'PRODUCTION',
      interest: 'TARGET',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2025-08-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.repo'],
  });

  addFact({
    fact_key: 'fact.ai.prompt_architecture.hands_on',
    engagement_key: 'guidebuoy.ai.founder_architect',
    fact_type: 'SKILL',
    statement: 'Hands-on prompt architecture: system prompt engineering, few-shot demonstration calibration, strict JSON schema enforcement, and zero-hallucination validation.',
    structured_value: {
      capability_family: 'AI_ENGINEERING',
      capability_name: 'prompt_architecture',
      display_label: 'Prompt Architecture & Schema Gating',
      proficiency: 'ADVANCED',
      hands_on_level: 'PRODUCTION',
      interest: 'TARGET',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2025-08-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.repo'],
  });

  addFact({
    fact_key: 'fact.ai.embeddings_vector_search.hands_on',
    engagement_key: 'guidebuoy.ai.founder_architect',
    fact_type: 'SKILL',
    statement: 'Hands-on embeddings and vector search: semantic matching with cosine similarity, embedding-space registry, dimensional validation, and hybrid lexical-semantic ranking.',
    structured_value: {
      capability_family: 'AI_ENGINEERING',
      capability_name: 'embeddings_vector_search',
      display_label: 'Embeddings & Vector Search',
      proficiency: 'ADVANCED',
      hands_on_level: 'PRODUCTION',
      interest: 'TARGET',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2025-08-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.repo'],
  });

  addFact({
    fact_key: 'fact.ai.ai_evaluation.learning',
    fact_type: 'SKILL',
    statement: 'AI evaluation: learning and developing automated benchmark evaluation, synthetic testing suites, and rubric-based output grading.',
    structured_value: {
      capability_family: 'AI_ENGINEERING',
      capability_name: 'ai_evaluation',
      display_label: 'AI Evaluation & Benchmarking',
      proficiency: 'LEARNING',
      hands_on_level: 'APPLIED_PROJECT',
      interest: 'STRONG',
      evidence_strength: 'APPLIED_PROJECT',
      recency: 'CURRENT',
      development_status: 'DEVELOPING',
    },
    evidence_tier: 'APPLIED_PROJECT',
    verification_status: 'SELF_ATTESTED',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.interview.stage1'],
  });

  addFact({
    fact_key: 'fact.ai.guardrails.conceptual',
    fact_type: 'SKILL',
    statement: 'Guardrails and validation layers: conceptual and knowledge-level understanding; neuro-symbolic deterministic validation implemented, but external guardrail frameworks still emerging.',
    structured_value: {
      capability_family: 'AI_ENGINEERING',
      capability_name: 'guardrails',
      display_label: 'LLM Guardrails & Safety Layers',
      proficiency: 'KNOWLEDGE_ONLY',
      hands_on_level: 'CONCEPTUAL',
      interest: 'SUPPORTING',
      evidence_strength: 'KNOWLEDGE_ONLY',
      recency: 'CURRENT',
      development_status: 'DEVELOPING',
    },
    evidence_tier: 'KNOWLEDGE_ONLY',
    verification_status: 'SELF_ATTESTED',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.interview.stage1'],
  });

  addFact({
    fact_key: 'fact.ai.ai_governance.domain_knowledge',
    engagement_key: 'guidebuoy.ai.founder_architect',
    fact_type: 'SKILL',
    statement: 'Advanced domain knowledge in AI governance: MAS FEAT/SRF guidelines, NIST AI RMF, and regulatory compliance mapping.',
    structured_value: {
      capability_family: 'AI_ENGINEERING',
      capability_name: 'ai_governance',
      display_label: 'AI Governance & Compliance Frameworks',
      proficiency: 'ADVANCED',
      hands_on_level: 'CONCEPTUAL',
      interest: 'TARGET',
      evidence_strength: 'KNOWLEDGE_ONLY',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'KNOWLEDGE_ONLY',
    verification_status: 'SELF_ATTESTED',
    start_date: '2025-08-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.profile'],
  });

  addFact({
    fact_key: 'fact.ai.conventional_ml.foundational',
    fact_type: 'SKILL',
    statement: 'Foundational conventional machine learning knowledge acquired via NTU Data Science and AI coursework; regression, classification, clustering basics.',
    structured_value: {
      capability_family: 'AI_ENGINEERING',
      capability_name: 'conventional_ml',
      display_label: 'Conventional Machine Learning',
      proficiency: 'FOUNDATIONAL',
      hands_on_level: 'COURSE_PROJECT',
      interest: 'ACCEPTABLE',
      evidence_strength: 'COURSE_PROJECT',
      recency: 'RECENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'COURSE_PROJECT',
    verification_status: 'SELF_ATTESTED',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.profile'],
  });

  addFact({
    fact_key: 'fact.ai.fine_tuning.planned',
    fact_type: 'SKILL',
    statement: 'Fine-tuning of foundation models: planned and learning; not yet implementation-proven in production.',
    structured_value: {
      capability_family: 'AI_ENGINEERING',
      capability_name: 'fine_tuning',
      display_label: 'Model Fine-Tuning (LoRA / SFT)',
      proficiency: 'LEARNING',
      hands_on_level: 'NONE',
      interest: 'SUPPORTING',
      evidence_strength: 'KNOWLEDGE_ONLY',
      recency: 'CURRENT',
      development_status: 'PLANNED',
    },
    evidence_tier: 'KNOWLEDGE_ONLY',
    verification_status: 'SELF_ATTESTED',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.interview.stage1'],
  });

  addFact({
    fact_key: 'fact.ai.classifier_development.planned',
    fact_type: 'SKILL',
    statement: 'Custom classifier development and training: planned expansion; not yet deployed in production.',
    structured_value: {
      capability_family: 'AI_ENGINEERING',
      capability_name: 'classifier_development',
      display_label: 'Classifier Development & Training',
      proficiency: 'LEARNING',
      hands_on_level: 'NONE',
      interest: 'SUPPORTING',
      evidence_strength: 'KNOWLEDGE_ONLY',
      recency: 'CURRENT',
      development_status: 'PLANNED',
    },
    evidence_tier: 'KNOWLEDGE_ONLY',
    verification_status: 'SELF_ATTESTED',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.interview.stage1'],
  });

  addFact({
    fact_key: 'fact.ai.model_training.planned',
    fact_type: 'SKILL',
    statement: 'From-scratch model training: planned expansion; not yet executed in production environments.',
    structured_value: {
      capability_family: 'AI_ENGINEERING',
      capability_name: 'model_training',
      display_label: 'Model Training from Scratch',
      proficiency: 'LEARNING',
      hands_on_level: 'NONE',
      interest: 'SUPPORTING',
      evidence_strength: 'KNOWLEDGE_ONLY',
      recency: 'CURRENT',
      development_status: 'PLANNED',
    },
    evidence_tier: 'KNOWLEDGE_ONLY',
    verification_status: 'SELF_ATTESTED',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.interview.stage1'],
  });

  addFact({
    fact_key: 'fact.ai.computer_vision.no_interest',
    fact_type: 'SKILL',
    statement: 'Computer vision: high-level conceptual knowledge only; explicit non-interest for future career roles.',
    structured_value: {
      capability_family: 'AI_ENGINEERING',
      capability_name: 'computer_vision',
      display_label: 'Computer Vision',
      proficiency: 'KNOWLEDGE_ONLY',
      hands_on_level: 'NONE',
      interest: 'NO_INTEREST',
      evidence_strength: 'KNOWLEDGE_ONLY',
      recency: 'HISTORICAL',
      development_status: 'CURRENT',
    },
    evidence_tier: 'KNOWLEDGE_ONLY',
    verification_status: 'SELF_ATTESTED',
    is_current: false,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.interview.stage1'],
  });

  addFact({
    fact_key: 'fact.ai.nlp_specialist.no_interest',
    fact_type: 'SKILL',
    statement: 'NLP specialist linguistics / low-level tokenizer engineering: explicit non-interest for future career roles; focus is on systems architecture and solution building.',
    structured_value: {
      capability_family: 'AI_ENGINEERING',
      capability_name: 'nlp_specialist',
      display_label: 'Low-Level NLP Specialist Engineering',
      proficiency: 'FOUNDATIONAL',
      hands_on_level: 'NONE',
      interest: 'NO_INTEREST',
      evidence_strength: 'KNOWLEDGE_ONLY',
      recency: 'HISTORICAL',
      development_status: 'CURRENT',
    },
    evidence_tier: 'KNOWLEDGE_ONLY',
    verification_status: 'SELF_ATTESTED',
    is_current: false,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.interview.stage1'],
  });

  // ==========================================================================
  // 4. DATA ARCHITECTURE & ANALYTICS
  // ==========================================================================
  addFact({
    fact_key: 'fact.data.data_modelling.capable',
    engagement_key: 'aia.aiaim.enterprise_architect_program_lead',
    fact_type: 'SKILL',
    statement: 'Advanced capability in relational and analytical data modelling, entity-relationship diagrams, schema normalization, and dimensional design.',
    structured_value: {
      capability_family: 'DATA_ANALYTICS',
      capability_name: 'data_modelling',
      display_label: 'Data Modelling & Schema Design',
      proficiency: 'ADVANCED',
      hands_on_level: 'PRODUCTION',
      interest: 'STRONG',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2023-04-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.profile'],
  });

  addFact({
    fact_key: 'fact.data.etl_pipelines.capable',
    engagement_key: 'guidebuoy.ai.founder_architect',
    fact_type: 'SKILL',
    statement: 'Capable implementation of data ingestion pipelines, ETL/ELT transformations, and schema verification scripts.',
    structured_value: {
      capability_family: 'DATA_ANALYTICS',
      capability_name: 'etl_pipelines',
      display_label: 'Data Pipelines & ETL / ELT',
      proficiency: 'INDEPENDENT',
      hands_on_level: 'APPLIED_PROJECT',
      interest: 'STRONG',
      evidence_strength: 'APPLIED_PROJECT',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'APPLIED_PROJECT',
    verification_status: 'SELF_ATTESTED',
    start_date: '2025-08-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.repo'],
  });

  addFact({
    fact_key: 'fact.data.analytics.capable',
    engagement_key: 'synpulse.algorithmic_wealth_researcher',
    fact_type: 'SKILL',
    statement: 'Advanced analytics capability across quantitative metrics, comparative benchmarking, and performance analysis.',
    structured_value: {
      capability_family: 'DATA_ANALYTICS',
      capability_name: 'analytics',
      display_label: 'Data Analytics & Performance Measurement',
      proficiency: 'ADVANCED',
      hands_on_level: 'PRODUCTION',
      interest: 'STRONG',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2017-08-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.profile'],
  });

  addFact({
    fact_key: 'fact.data.vector_databases.hands_on',
    engagement_key: 'guidebuoy.ai.founder_architect',
    fact_type: 'TECHNOLOGY',
    statement: 'Production-capable hands-on experience with vector databases and extensions (pgvector in Neon, embeddings indexing, cosine search).',
    structured_value: {
      capability_family: 'DATA_ANALYTICS',
      capability_name: 'vector_databases',
      display_label: 'Vector Databases (pgvector)',
      proficiency: 'PRODUCTION_CAPABLE',
      hands_on_level: 'APPLIED_PROJECT',
      interest: 'TARGET',
      evidence_strength: 'APPLIED_PROJECT',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'APPLIED_PROJECT',
    verification_status: 'SELF_ATTESTED',
    start_date: '2025-08-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.repo'],
  });

  addFact({
    fact_key: 'fact.data.bi_reporting.expert',
    engagement_key: 'pop.pmo_sfa_delivery_architect',
    fact_type: 'SKILL',
    statement: 'Strong prior experience architecting BI reporting platforms, executive dashboards, and sales analytics for multi-market enterprises.',
    structured_value: {
      capability_family: 'DATA_ANALYTICS',
      capability_name: 'bi_reporting',
      display_label: 'Business Intelligence (BI) & Dashboards',
      proficiency: 'EXPERT',
      hands_on_level: 'PRODUCTION',
      interest: 'ACCEPTABLE',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'HISTORICAL',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2009-10-01',
    end_date: '2012-01-31',
    is_current: false,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.profile'],
  });

  addFact({
    fact_key: 'fact.data.statistics.capable',
    fact_type: 'SKILL',
    statement: 'Capable in applied statistics, descriptive and inferential metrics, hypothesis testing, and quantitative research methods.',
    structured_value: {
      capability_family: 'DATA_ANALYTICS',
      capability_name: 'statistics',
      display_label: 'Applied Statistics & Quantitative Analysis',
      proficiency: 'INDEPENDENT',
      hands_on_level: 'COURSE_PROJECT',
      interest: 'STRONG',
      evidence_strength: 'COURSE_PROJECT',
      recency: 'RECENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'COURSE_PROJECT',
    verification_status: 'SELF_ATTESTED',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.profile'],
  });

  addFact({
    fact_key: 'fact.data.warehouses_lakes.conceptual',
    fact_type: 'SKILL',
    statement: 'Conceptual and course knowledge of modern data warehouses and data lakes (Snowflake, BigQuery concepts); not production-proven.',
    structured_value: {
      capability_family: 'DATA_ANALYTICS',
      capability_name: 'warehouses_lakes',
      display_label: 'Data Warehousing & Lakes',
      proficiency: 'FOUNDATIONAL',
      hands_on_level: 'COURSE_PROJECT',
      interest: 'ACCEPTABLE',
      evidence_strength: 'COURSE_PROJECT',
      recency: 'RECENT',
      development_status: 'DEVELOPING',
    },
    evidence_tier: 'COURSE_PROJECT',
    verification_status: 'SELF_ATTESTED',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.profile'],
  });

  addFact({
    fact_key: 'fact.data.data_governance.domain_knowledge',
    engagement_key: 'aia.aiaim.enterprise_architect_program_lead',
    fact_type: 'SKILL',
    statement: 'Advanced domain knowledge in data governance: data lineage, confidentiality classification, master data management, and audit integrity.',
    structured_value: {
      capability_family: 'DATA_ANALYTICS',
      capability_name: 'data_governance',
      display_label: 'Data Governance & Lineage',
      proficiency: 'ADVANCED',
      hands_on_level: 'PRODUCTION',
      interest: 'SUPPORTING',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2023-04-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.profile'],
  });

  addFact({
    fact_key: 'fact.data.quant_modelling.not_target',
    fact_type: 'SKILL',
    statement: 'Quantitative financial modelling: foundational knowledge; explicit non-target work activity for future career roles.',
    structured_value: {
      capability_family: 'DATA_ANALYTICS',
      capability_name: 'quant_modelling',
      display_label: 'Quantitative Financial Modelling',
      proficiency: 'FOUNDATIONAL',
      hands_on_level: 'COURSE_PROJECT',
      interest: 'AVOID',
      evidence_strength: 'COURSE_PROJECT',
      recency: 'HISTORICAL',
      development_status: 'CURRENT',
    },
    evidence_tier: 'COURSE_PROJECT',
    verification_status: 'SELF_ATTESTED',
    is_current: false,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.profile'],
  });

  // ==========================================================================
  // 5. PRODUCT STRATEGY & DISCOVERY
  // ==========================================================================
  addFact({
    fact_key: 'fact.product.problem_discovery.expert',
    engagement_key: 'guidebuoy.ai.founder_architect',
    fact_type: 'SKILL',
    statement: 'Expert in problem discovery: identifying systemic friction, customer vulnerabilities, unaddressed compliance gaps, and high-impact automation targets.',
    structured_value: {
      capability_family: 'PRODUCT',
      capability_name: 'problem_discovery',
      display_label: 'Problem Discovery',
      proficiency: 'EXPERT',
      hands_on_level: 'PRODUCTION',
      interest: 'TARGET',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2025-08-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.product'],
  });

  addFact({
    fact_key: 'fact.product.customer_user_research.advanced',
    engagement_key: 'guidebuoy.ai.founder_architect',
    fact_type: 'SKILL',
    statement: 'Advanced user research: conducting user interviews, user journey mapping, claimant friction studies, and institutional partner reviews.',
    structured_value: {
      capability_family: 'PRODUCT',
      capability_name: 'customer_user_research',
      display_label: 'Customer & User Research',
      proficiency: 'ADVANCED',
      hands_on_level: 'PRODUCTION',
      interest: 'STRONG',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2025-08-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.product'],
  });

  addFact({
    fact_key: 'fact.product.requirements_engineering.expert',
    engagement_key: 'aia.aiaim.enterprise_architect_program_lead',
    fact_type: 'SKILL',
    statement: 'Expert in requirements engineering: translating complex regulatory mandates and stakeholder needs into unambiguous executable specifications.',
    structured_value: {
      capability_family: 'PRODUCT',
      capability_name: 'requirements_engineering',
      display_label: 'Requirements Engineering',
      proficiency: 'EXPERT',
      hands_on_level: 'PRODUCTION',
      interest: 'TARGET',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2023-04-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.profile'],
  });

  addFact({
    fact_key: 'fact.product.roadmap_architecture.expert',
    engagement_key: 'guidebuoy.ai.founder_architect',
    fact_type: 'SKILL',
    statement: 'Expert in product roadmap design: sequencing dependencies, phase gating, technical milestones, and balancing MVP viability with architectural runway.',
    structured_value: {
      capability_family: 'PRODUCT',
      capability_name: 'roadmap_architecture',
      display_label: 'Product Roadmap Design',
      proficiency: 'EXPERT',
      hands_on_level: 'PRODUCTION',
      interest: 'TARGET',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2025-08-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.product'],
  });

  addFact({
    fact_key: 'fact.product.ai_assisted_ux_prototyping.applied',
    engagement_key: 'guidebuoy.ai.founder_architect',
    fact_type: 'SKILL',
    statement: 'Applied AI-assisted UX design and rapid prototyping: building interactive web interfaces, flow wireframes, and live clickable demonstrators.',
    structured_value: {
      capability_family: 'PRODUCT',
      capability_name: 'ai_assisted_ux_prototyping',
      display_label: 'AI-Assisted UX & Prototyping',
      proficiency: 'ADVANCED',
      hands_on_level: 'APPLIED_PROJECT',
      interest: 'STRONG',
      evidence_strength: 'APPLIED_PROJECT',
      recency: 'CURRENT',
      ai_assisted: true,
      development_status: 'CURRENT',
    },
    evidence_tier: 'APPLIED_PROJECT',
    verification_status: 'SELF_ATTESTED',
    start_date: '2025-08-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.product'],
  });

  addFact({
    fact_key: 'fact.product.backlog_management.advanced',
    engagement_key: 'smu.big.founder_in_residence',
    fact_type: 'SKILL',
    statement: 'Advanced product and backlog management: user story definition, acceptance criteria, epic breakdown, and sprint prioritization.',
    structured_value: {
      capability_family: 'PRODUCT',
      capability_name: 'backlog_management',
      display_label: 'Product Backlog Management',
      proficiency: 'ADVANCED',
      hands_on_level: 'PRODUCTION',
      interest: 'STRONG',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2026-01-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.product'],
  });

  addFact({
    fact_key: 'fact.product.gtm_planning.advanced',
    engagement_key: 'guidebuoy.ai.founder_architect',
    fact_type: 'SKILL',
    statement: 'Go-to-market (GTM) planning: stakeholder positioning, partner alignment, early-adopter beta rollouts, and institutional outreach.',
    structured_value: {
      capability_family: 'PRODUCT',
      capability_name: 'gtm_planning',
      display_label: 'Go-To-Market (GTM) Planning',
      proficiency: 'ADVANCED',
      hands_on_level: 'PRODUCTION',
      interest: 'STRONG',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2025-08-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.product'],
  });

  addFact({
    fact_key: 'fact.product.idea_to_mvp_to_production.advanced',
    engagement_key: 'guidebuoy.ai.founder_architect',
    fact_type: 'ACHIEVEMENT',
    statement: 'Proven capability taking a software product end-to-end from conceptual idea to architecture, functional MVP, and first production release in 6 months.',
    structured_value: {
      capability_family: 'PRODUCT',
      capability_name: 'idea_to_mvp_to_production',
      display_label: '0-to-1 Product MVP to Production',
      proficiency: 'ADVANCED',
      hands_on_level: 'PRODUCTION',
      interest: 'TARGET',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2025-08-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.product'],
  });

  addFact({
    fact_key: 'fact.product.pricing_experimentation.developing',
    fact_type: 'SKILL',
    statement: 'Pricing models and product experimentation: developing and foundational knowledge rather than expert.',
    structured_value: {
      capability_family: 'PRODUCT',
      capability_name: 'pricing_experimentation',
      display_label: 'Pricing Models & Product Experimentation',
      proficiency: 'FOUNDATIONAL',
      hands_on_level: 'APPLIED_PROJECT',
      interest: 'SUPPORTING',
      evidence_strength: 'APPLIED_PROJECT',
      recency: 'CURRENT',
      development_status: 'DEVELOPING',
    },
    evidence_tier: 'APPLIED_PROJECT',
    verification_status: 'SELF_ATTESTED',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.interview.stage1'],
  });

  // ==========================================================================
  // 6. TECHNICAL DELIVERY & TRANSFORMATION
  // ==========================================================================
  addFact({
    fact_key: 'fact.delivery.programme_rescue.expert',
    engagement_key: 'aia.aiaim.enterprise_architect_program_lead',
    fact_type: 'ACHIEVEMENT',
    statement: 'Rescued high-stakes institutional transformation at AIA Investment Management, transforming previously troubled streams into on-schedule compliant delivery.',
    structured_value: {
      capability_family: 'TECHNICAL_DELIVERY',
      capability_name: 'programme_rescue',
      display_label: 'Programme Rescue & Recovery',
      proficiency: 'EXPERT',
      hands_on_level: 'PRODUCTION',
      interest: 'SUPPORTING',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'RECENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2023-04-01',
    end_date: '2025-04-30',
    is_current: false,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.profile'],
  });

  addFact({
    fact_key: 'fact.delivery.transformation_decomposition.expert',
    engagement_key: 'aia.aiaim.enterprise_architect_program_lead',
    fact_type: 'SKILL',
    statement: 'Expert at decomposing massive, multi-threaded enterprise transformations into distinct, risk-bounded work packages and architectures.',
    structured_value: {
      capability_family: 'TECHNICAL_DELIVERY',
      capability_name: 'transformation_decomposition',
      display_label: 'Transformation Decomposition',
      proficiency: 'EXPERT',
      hands_on_level: 'PRODUCTION',
      interest: 'TARGET',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'RECENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2023-04-01',
    end_date: '2025-04-30',
    is_current: false,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.profile'],
  });

  addFact({
    fact_key: 'fact.delivery.dependency_architecture.expert',
    engagement_key: 'mondelez.regional_crm_sfa_architect',
    fact_type: 'SKILL',
    statement: 'Expert in dependency architecture across regional enterprise systems, legacy core platforms, external vendor releases, and regulatory deadlines.',
    structured_value: {
      capability_family: 'TECHNICAL_DELIVERY',
      capability_name: 'dependency_architecture',
      display_label: 'Cross-System Dependency Architecture',
      proficiency: 'EXPERT',
      hands_on_level: 'PRODUCTION',
      interest: 'TARGET',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2012-02-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.profile'],
  });

  addFact({
    fact_key: 'fact.delivery.vendor_management.expert',
    engagement_key: 'mondelez.regional_crm_sfa_architect',
    fact_type: 'SKILL',
    statement: 'Expert in vendor evaluation, RFP selection, contract deliverables governance, and vendor delivery management across 16 APAC markets.',
    structured_value: {
      capability_family: 'TECHNICAL_DELIVERY',
      capability_name: 'vendor_management',
      display_label: 'Vendor Management & RFP Governance',
      proficiency: 'EXPERT',
      hands_on_level: 'PRODUCTION',
      interest: 'SUPPORTING',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'RECENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2012-02-01',
    end_date: '2017-09-30',
    is_current: false,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.profile'],
  });

  addFact({
    fact_key: 'fact.delivery.programme_coordination.avoid',
    fact_type: 'SKILL',
    statement: 'Routine programme administration and administrative PMO coordination: proven capability, but explicitly marked as NOT a future target work activity.',
    structured_value: {
      capability_family: 'TECHNICAL_DELIVERY',
      capability_name: 'programme_coordination',
      display_label: 'Routine Programme Coordination & PMO Admin',
      proficiency: 'EXPERT',
      hands_on_level: 'PRODUCTION',
      interest: 'AVOID',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'HISTORICAL',
      development_status: 'CURRENT',
      notes: 'Proven ability to coordinate complex programs, but actively seeking to avoid routine administrative PMO coordination.',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    is_current: false,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.interview.stage1'],
  });

  // ==========================================================================
  // 7. RESEARCH & COMPLEX PROBLEM SOLVING
  // ==========================================================================
  addFact({
    fact_key: 'fact.research.research_synthesis.expert',
    engagement_key: 'audhd.research_lab.founder',
    fact_type: 'SKILL',
    statement: 'Exceptionally strong research synthesis capability: extracting core insights from hundreds of complex scientific and domain papers into actionable models.',
    structured_value: {
      capability_family: 'RESEARCH',
      capability_name: 'research_synthesis',
      display_label: 'Research Synthesis & Meta-Analysis',
      proficiency: 'EXPERT',
      hands_on_level: 'PRODUCTION',
      interest: 'TARGET',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2026-05-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.repo'],
  });

  addFact({
    fact_key: 'fact.research.pattern_discovery.expert',
    fact_type: 'SKILL',
    statement: 'Exceptionally strong pattern recognition and hypothesis generation across disparate fields, connecting biology, neurology, finance, and software architecture.',
    structured_value: {
      capability_family: 'RESEARCH',
      capability_name: 'pattern_discovery',
      display_label: 'Cross-Domain Pattern Discovery',
      proficiency: 'EXPERT',
      hands_on_level: 'PRODUCTION',
      interest: 'TARGET',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.interview.stage1'],
  });

  addFact({
    fact_key: 'fact.research.scientific_writing.ai_assisted',
    engagement_key: 'audhd.research_lab.founder',
    fact_type: 'SKILL',
    statement: 'Scientific and academic paper drafting: capable with AI assistance, producing structured literature reviews and research proposals.',
    structured_value: {
      capability_family: 'RESEARCH',
      capability_name: 'scientific_writing',
      display_label: 'Scientific & Academic Writing',
      proficiency: 'INDEPENDENT',
      hands_on_level: 'APPLIED_PROJECT',
      interest: 'TARGET',
      evidence_strength: 'APPLIED_PROJECT',
      recency: 'CURRENT',
      ai_assisted: true,
      development_status: 'CURRENT',
    },
    evidence_tier: 'APPLIED_PROJECT',
    verification_status: 'SELF_ATTESTED',
    start_date: '2026-05-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.repo'],
  });

  addFact({
    fact_key: 'fact.research.investment_research.expert',
    engagement_key: 'synpulse.algorithmic_wealth_researcher',
    fact_type: 'SKILL',
    statement: 'Proven institutional investment research: conducted in-depth comparative audit of 21 digital wealth platforms across Singapore and Hong Kong.',
    structured_value: {
      capability_family: 'RESEARCH',
      capability_name: 'investment_research',
      display_label: 'Investment & Wealth Platform Research',
      proficiency: 'EXPERT',
      hands_on_level: 'PRODUCTION',
      interest: 'STRONG',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'RECENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2017-08-01',
    end_date: '2018-01-31',
    is_current: false,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.profile'],
  });

  addFact({
    fact_key: 'fact.research.policy_research.not_target',
    fact_type: 'SKILL',
    statement: 'Pure public policy research: foundational knowledge; not a target work activity.',
    structured_value: {
      capability_family: 'RESEARCH',
      capability_name: 'policy_research',
      display_label: 'Public Policy Research',
      proficiency: 'FOUNDATIONAL',
      hands_on_level: 'CONCEPTUAL',
      interest: 'AVOID',
      evidence_strength: 'KNOWLEDGE_ONLY',
      recency: 'HISTORICAL',
      development_status: 'CURRENT',
    },
    evidence_tier: 'KNOWLEDGE_ONLY',
    verification_status: 'SELF_ATTESTED',
    is_current: false,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.interview.stage1'],
  });

  // ==========================================================================
  // 8. GOVERNANCE, RISK & COMPLIANCE
  // ==========================================================================
  addFact({
    fact_key: 'fact.gov.regulatory_controls.advanced',
    engagement_key: 'guidebuoy.ai.founder_architect',
    fact_type: 'SKILL',
    statement: 'Advanced capability implementing regulatory controls, MAS compliance rules, and automated audit checks.',
    structured_value: {
      capability_family: 'GOVERNANCE_RISK',
      capability_name: 'regulatory_controls',
      display_label: 'Regulatory Controls & Compliance Automation',
      proficiency: 'ADVANCED',
      hands_on_level: 'PRODUCTION',
      interest: 'TARGET',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2025-08-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.product'],
  });

  addFact({
    fact_key: 'fact.gov.legal_process_design.advanced',
    engagement_key: 'guidebuoy.ai.founder_architect',
    fact_type: 'SKILL',
    statement: 'Advanced legal-process design: converting complex statutory mandates into deterministic workflows for dispute resolution.',
    structured_value: {
      capability_family: 'GOVERNANCE_RISK',
      capability_name: 'legal_process_design',
      display_label: 'Legal Process & Dispute Workflow Design',
      proficiency: 'ADVANCED',
      hands_on_level: 'PRODUCTION',
      interest: 'TARGET',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2025-08-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.product'],
  });

  addFact({
    fact_key: 'fact.gov.audit_framework.scoped',
    fact_type: 'SKILL',
    statement: 'Operational audit evidence and documentation: expert capability; strictly bounded to technical and operational evidence, not certified accounting audit frameworks.',
    structured_value: {
      capability_family: 'GOVERNANCE_RISK',
      capability_name: 'audit_evidence_documentation',
      display_label: 'Technical Audit Evidence & Provenance',
      proficiency: 'EXPERT',
      hands_on_level: 'PRODUCTION',
      interest: 'TARGET',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
      notes: 'No external accounting/statutory audit framework certification claimed; strictly technical/operational audit evidence.',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.interview.stage1'],
  });

  // ==========================================================================
  // 9. DOMAIN & INDUSTRY EXPERTISE
  // ==========================================================================
  addFact({
    fact_key: 'fact.domain.capital_markets.5',
    engagement_key: 'aia.aiaim.enterprise_architect_program_lead',
    fact_type: 'DOMAIN',
    statement: 'Capital Markets domain expertise (Self-rating: 5/5): institutional trading, fixed income, FX, derivatives transformation.',
    structured_value: {
      capability_family: 'DOMAIN_EXPERTISE',
      domain: 'capital_markets',
      display_label: 'Capital Markets & Institutional Trading',
      rating: 5,
      self_rating: '5/5',
      proficiency: 'EXPERT',
      interest: 'STRONG',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'RECENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2023-04-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.profile'],
  });

  addFact({
    fact_key: 'fact.domain.wealth_management.5',
    engagement_key: 'farringdon.asset_management.associate_director',
    fact_type: 'DOMAIN',
    statement: 'Wealth Management domain expertise (Self-rating: 5/5): portfolio suitability, advisory workflows, DPM, custodian integrations.',
    structured_value: {
      capability_family: 'DOMAIN_EXPERTISE',
      domain: 'wealth_management',
      display_label: 'Wealth Management & Private Banking',
      rating: 5,
      self_rating: '5/5',
      proficiency: 'EXPERT',
      interest: 'SUPPORTING',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'RECENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2019-07-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.profile'],
  });

  addFact({
    fact_key: 'fact.domain.fmcg_crm.5',
    engagement_key: 'mondelez.regional_crm_sfa_architect',
    fact_type: 'DOMAIN',
    statement: 'FMCG & Commercial Enterprise CRM domain expertise (Self-rating: 5/5): regional sales force automation, distributor integration, master data hubs.',
    structured_value: {
      capability_family: 'DOMAIN_EXPERTISE',
      domain: 'fmcg_crm',
      display_label: 'FMCG & Enterprise CRM',
      rating: 5,
      self_rating: '5/5',
      proficiency: 'EXPERT',
      interest: 'SUPPORTING',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'HISTORICAL',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2012-02-01',
    end_date: '2017-09-30',
    is_current: false,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.profile'],
  });

  addFact({
    fact_key: 'fact.domain.investment_asset_management.4',
    engagement_key: 'aia.aiaim.enterprise_architect_program_lead',
    fact_type: 'DOMAIN',
    statement: 'Investment & Asset Management domain expertise (Self-rating: 4/5): front-to-back operational workflows, portfolio analytics, and regulatory filings.',
    structured_value: {
      capability_family: 'DOMAIN_EXPERTISE',
      domain: 'investment_asset_management',
      display_label: 'Investment & Asset Management',
      rating: 4,
      self_rating: '4/5',
      proficiency: 'ADVANCED',
      interest: 'STRONG',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'RECENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2023-04-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.profile'],
  });

  addFact({
    fact_key: 'fact.domain.fintech.4',
    engagement_key: 'guidebuoy.ai.founder_architect',
    fact_type: 'DOMAIN',
    statement: 'FinTech domain expertise (Self-rating: 4/5): robo-advisory architectures, digital onboarding, automated KYC, and payment integrations.',
    structured_value: {
      capability_family: 'DOMAIN_EXPERTISE',
      domain: 'fintech',
      display_label: 'FinTech Platforms & Digital Finance',
      rating: 4,
      self_rating: '4/5',
      proficiency: 'ADVANCED',
      interest: 'TARGET',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2025-08-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.product'],
  });

  addFact({
    fact_key: 'fact.domain.fraud_kyc_aml.4',
    engagement_key: 'guidebuoy.ai.founder_architect',
    fact_type: 'DOMAIN',
    statement: 'Fraud, KYC, and AML domain expertise (Self-rating: 4/5): automated triage, scam detection workflows, and institutional compliance.',
    structured_value: {
      capability_family: 'DOMAIN_EXPERTISE',
      domain: 'fraud_kyc_aml',
      display_label: 'Fraud Detection, KYC & AML',
      rating: 4,
      self_rating: '4/5',
      proficiency: 'ADVANCED',
      interest: 'TARGET',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2025-08-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.product'],
  });

  addFact({
    fact_key: 'fact.domain.ai_governance.4',
    engagement_key: 'guidebuoy.ai.founder_architect',
    fact_type: 'DOMAIN',
    statement: 'AI Governance domain expertise (Self-rating: 4/5): responsible AI principles, algorithmic transparency, auditability, and safety frameworks.',
    structured_value: {
      capability_family: 'DOMAIN_EXPERTISE',
      domain: 'ai_governance',
      display_label: 'AI Governance & Safety',
      rating: 4,
      self_rating: '4/5',
      proficiency: 'ADVANCED',
      interest: 'TARGET',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2025-08-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.product'],
  });

  addFact({
    fact_key: 'fact.domain.social_impact_development.4',
    engagement_key: 'mun_far_east.digital_infrastructure_lead',
    fact_type: 'DOMAIN',
    statement: 'Social Impact & International Development domain expertise (Self-rating: 4/5): educational initiatives, non-profit digital platforms, and NGO consulting.',
    structured_value: {
      capability_family: 'DOMAIN_EXPERTISE',
      domain: 'social_impact_development',
      display_label: 'Social Impact & International Development',
      rating: 4,
      self_rating: '4/5',
      proficiency: 'ADVANCED',
      interest: 'SUPPORTING',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'HISTORICAL',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2002-04-01',
    is_current: false,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.profile'],
  });

  addFact({
    fact_key: 'fact.domain.legal_regulatory.3',
    engagement_key: 'guidebuoy.ai.founder_architect',
    fact_type: 'DOMAIN',
    statement: 'Legal & Regulatory domain expertise (Self-rating: 3/5, targeted scope): financial regulations, dispute resolution procedures, and compliance automation.',
    structured_value: {
      capability_family: 'DOMAIN_EXPERTISE',
      domain: 'legal_regulatory',
      display_label: 'Legal & Regulatory Tech',
      rating: 3,
      self_rating: '3/5',
      proficiency: 'INDEPENDENT',
      interest: 'TARGET',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2025-08-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.product'],
  });

  addFact({
    fact_key: 'fact.domain.healthcare.2',
    fact_type: 'DOMAIN',
    statement: 'Healthcare domain expertise (Self-rating: 2/5, developing): targeted interest in health-tech data standards and clinical workflows.',
    structured_value: {
      capability_family: 'DOMAIN_EXPERTISE',
      domain: 'healthcare',
      display_label: 'Healthcare & Health-Tech',
      rating: 2,
      self_rating: '2/5',
      proficiency: 'FOUNDATIONAL',
      interest: 'STRONG',
      evidence_strength: 'KNOWLEDGE_ONLY',
      recency: 'CURRENT',
      development_status: 'DEVELOPING',
    },
    evidence_tier: 'KNOWLEDGE_ONLY',
    verification_status: 'SELF_ATTESTED',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.interview.stage1'],
  });

  addFact({
    fact_key: 'fact.domain.biotech_pharma.2',
    engagement_key: 'audhd.research_lab.founder',
    fact_type: 'DOMAIN',
    statement: 'Biotech & Pharma domain expertise (Self-rating: 2/5, developing): scientific research pipelines, active ingredient analysis, and biological data processing.',
    structured_value: {
      capability_family: 'DOMAIN_EXPERTISE',
      domain: 'biotech_pharma',
      display_label: 'Biotech & Pharma Research',
      rating: 2,
      self_rating: '2/5',
      proficiency: 'FOUNDATIONAL',
      interest: 'STRONG',
      evidence_strength: 'APPLIED_PROJECT',
      recency: 'CURRENT',
      development_status: 'DEVELOPING',
    },
    evidence_tier: 'APPLIED_PROJECT',
    verification_status: 'SELF_ATTESTED',
    start_date: '2026-05-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.repo'],
  });

  addFact({
    fact_key: 'fact.domain.academic_research.2',
    engagement_key: 'audhd.research_lab.founder',
    fact_type: 'DOMAIN',
    statement: 'Academic Research domain expertise (Self-rating: 2/5, developing): empirical literature reviews, scientific hypothesis automation, and research synthesis.',
    structured_value: {
      capability_family: 'DOMAIN_EXPERTISE',
      domain: 'academic_research',
      display_label: 'Academic Research & Synthesis',
      rating: 2,
      self_rating: '2/5',
      proficiency: 'FOUNDATIONAL',
      interest: 'STRONG',
      evidence_strength: 'APPLIED_PROJECT',
      recency: 'CURRENT',
      development_status: 'DEVELOPING',
    },
    evidence_tier: 'APPLIED_PROJECT',
    verification_status: 'SELF_ATTESTED',
    start_date: '2026-05-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.repo'],
  });

  addFact({
    fact_key: 'fact.domain.sustainability_climate.1',
    fact_type: 'DOMAIN',
    statement: 'Sustainability & Climate domain expertise (Self-rating: 1/5): past coursework and early audit exposure; explicitly NOT a target future career domain.',
    structured_value: {
      capability_family: 'DOMAIN_EXPERTISE',
      domain: 'sustainability_climate',
      display_label: 'Sustainability & Climate',
      rating: 1,
      self_rating: '1/5',
      proficiency: 'FOUNDATIONAL',
      interest: 'AVOID',
      evidence_strength: 'KNOWLEDGE_ONLY',
      recency: 'HISTORICAL',
      development_status: 'CURRENT',
    },
    evidence_tier: 'KNOWLEDGE_ONLY',
    verification_status: 'SELF_ATTESTED',
    is_current: false,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.interview.stage1'],
  });

  // ==========================================================================
  // 10. LEADERSHIP & INFLUENCE
  // ==========================================================================
  addFact({
    fact_key: 'fact.lead.architecture_authority.target',
    engagement_key: 'aia.aiaim.enterprise_architect_program_lead',
    fact_type: 'SKILL',
    statement: 'Architecture authority: setting technical vision, establishing system standards, and validating cross-stream design compliance.',
    structured_value: {
      capability_family: 'LEADERSHIP',
      leadership_mode: 'Architecture Authority',
      display_label: 'Architecture Authority & Technical Governance',
      proficiency: 'EXPERT',
      interest: 'TARGET',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2023-04-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.profile'],
  });

  addFact({
    fact_key: 'fact.lead.small_expert_teams.target',
    engagement_key: 'smu.big.founder_in_residence',
    fact_type: 'SKILL',
    statement: 'Leading small, high-density expert teams of senior engineers, researchers, and specialists.',
    structured_value: {
      capability_family: 'LEADERSHIP',
      leadership_mode: 'Small Expert Teams',
      display_label: 'Leading Small Expert Teams',
      proficiency: 'ADVANCED',
      interest: 'TARGET',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2026-01-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.product'],
  });

  addFact({
    fact_key: 'fact.lead.selected_mentoring.acceptable',
    fact_type: 'SKILL',
    statement: 'Selected mentoring of high-potential technical talent; targeted, focused, and bounded.',
    structured_value: {
      capability_family: 'LEADERSHIP',
      leadership_mode: 'Selected Mentoring',
      display_label: 'Selected Technical Mentoring',
      proficiency: 'ADVANCED',
      interest: 'ACCEPTABLE',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.profile'],
  });

  addFact({
    fact_key: 'fact.lead.heavy_people_management.avoid',
    fact_type: 'SKILL',
    statement: 'Large-scale direct people management, appraisal administration, and performance management: proven capability, but explicitly non-target work.',
    structured_value: {
      capability_family: 'LEADERSHIP',
      leadership_mode: 'Heavy People Management',
      display_label: 'Large People Management & Appraisals',
      proficiency: 'ADVANCED',
      interest: 'AVOID',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'HISTORICAL',
      development_status: 'CURRENT',
      notes: 'Can lead SteerCos and teams, but seeks to avoid bureaucratic people-management-heavy roles.',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    is_current: false,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.interview.stage1'],
  });

  addFact({
    fact_key: 'fact.lead.sales_client_leadership.avoid',
    fact_type: 'SKILL',
    statement: 'Client-facing commercial leadership, quota-carrying sales, and executive political navigation: to be avoided in future positions.',
    structured_value: {
      capability_family: 'LEADERSHIP',
      leadership_mode: 'Sales & Political Leadership',
      display_label: 'Client-Facing Sales & Political Leadership',
      proficiency: 'ADVANCED',
      interest: 'AVOID',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'HISTORICAL',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    is_current: false,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.interview.stage1'],
  });

  // ==========================================================================
  // 11. COMMUNICATION & INTERACTION PREFERENCES
  // ==========================================================================
  addFact({
    fact_key: 'fact.comm.technical_writing_diagrams.target',
    engagement_key: 'aia.aiaim.enterprise_architect_program_lead',
    fact_type: 'SKILL',
    statement: 'Technical writing, architecture blueprints, data dictionaries, and executive transformation decks.',
    structured_value: {
      capability_family: 'COMMUNICATION',
      capability_name: 'technical_writing_diagrams',
      display_label: 'Technical Writing & Architecture Blueprints',
      proficiency: 'EXPERT',
      interest: 'TARGET',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2023-04-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.profile'],
  });

  addFact({
    fact_key: 'fact.comm.facilitation_workshops.supporting',
    engagement_key: 'mondelez.regional_crm_sfa_architect',
    fact_type: 'SKILL',
    statement: 'Cross-functional workshop facilitation and stakeholder translation; capable, but undesirable as a primary work fraction (ceiling ~10%).',
    structured_value: {
      capability_family: 'COMMUNICATION',
      capability_name: 'facilitation_workshops',
      display_label: 'Stakeholder Facilitation & Workshops',
      proficiency: 'ADVANCED',
      interest: 'SUPPORTING',
      ceiling_pct: 10,
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'RECENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2012-02-01',
    is_current: false,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.profile'],
  });

  // ==========================================================================
  // 12. FOUNDER & OPERATOR CAPABILITIES
  // ==========================================================================
  addFact({
    fact_key: 'fact.founder.company_creation_operations.guidebuoy',
    engagement_key: 'guidebuoy.ai.founder_architect',
    fact_type: 'PROJECT',
    statement: 'End-to-end founder operations at GuideBuoy AI: incorporated entity, product design, grants writing, GTM planning, tax/statutory compliance, and production deployment.',
    structured_value: {
      capability_family: 'FOUNDER_OPERATOR',
      capability_name: 'company_creation_operations',
      display_label: '0-to-1 Company Creation & Operations',
      proficiency: 'ADVANCED',
      hands_on_level: 'PRODUCTION',
      interest: 'TARGET',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2025-08-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.product'],
  });

  addFact({
    fact_key: 'fact.founder.grants_pitch_decks.guidebuoy',
    engagement_key: 'smu.big.founder_in_residence',
    fact_type: 'ACHIEVEMENT',
    statement: 'Drafted institutional pitch decks and grant proposals, securing incubation at SMU BIG and $20,000 in potential pipeline funding.',
    structured_value: {
      capability_family: 'FOUNDER_OPERATOR',
      capability_name: 'grants_pitch_decks',
      display_label: 'Grants Writing & Investor Decks',
      proficiency: 'ADVANCED',
      hands_on_level: 'PRODUCTION',
      interest: 'STRONG',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2026-01-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.product'],
  });

  // ==========================================================================
  // 13. LANGUAGES & REGIONAL EXPERIENCE
  // ==========================================================================
  addFact({
    fact_key: 'fact.lang.english.fluent',
    fact_type: 'SKILL',
    statement: 'English language proficiency: fluent and professional in speaking, reading, and writing across technical and executive contexts.',
    structured_value: {
      capability_family: 'LANGUAGES_GEOGRAPHY',
      language: 'English',
      speaking: 'FLUENT',
      reading: 'FLUENT',
      writing: 'FLUENT',
      proficiency: 'EXPERT',
      interest: 'TARGET',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'VERIFIED',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.profile'],
  });

  addFact({
    fact_key: 'fact.lang.russian.native',
    fact_type: 'SKILL',
    statement: 'Russian language proficiency: native in speaking, reading, and writing.',
    structured_value: {
      capability_family: 'LANGUAGES_GEOGRAPHY',
      language: 'Russian',
      speaking: 'NATIVE',
      reading: 'NATIVE',
      writing: 'NATIVE',
      proficiency: 'EXPERT',
      interest: 'SUPPORTING',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'VERIFIED',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.profile'],
  });

  addFact({
    fact_key: 'fact.lang.mandarin.conversational',
    engagement_key: 'pop.pmo_sfa_delivery_architect',
    fact_type: 'SKILL',
    statement: 'Mandarin Chinese proficiency: conversational colleague-level speaking; assisted reading for complex technical text; pinyin-supported writing.',
    structured_value: {
      capability_family: 'LANGUAGES_GEOGRAPHY',
      language: 'Mandarin Chinese',
      speaking: 'CONVERSATIONAL_COLLEAGUE',
      reading: 'ASSISTED_COMPLEX',
      writing: 'PINYIN_SUPPORTED',
      proficiency: 'INDEPENDENT',
      interest: 'STRONG',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2008-05-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.profile'],
  });

  addFact({
    fact_key: 'fact.lang.german.basic',
    fact_type: 'SKILL',
    statement: 'German language proficiency: basic speaking, reading, and writing.',
    structured_value: {
      capability_family: 'LANGUAGES_GEOGRAPHY',
      language: 'German',
      speaking: 'BASIC',
      reading: 'BASIC',
      writing: 'BASIC',
      proficiency: 'FOUNDATIONAL',
      interest: 'SUPPORTING',
      evidence_strength: 'COURSE_PROJECT',
      recency: 'HISTORICAL',
      development_status: 'CURRENT',
    },
    evidence_tier: 'COURSE_PROJECT',
    verification_status: 'SELF_ATTESTED',
    is_current: false,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.profile'],
  });

  addFact({
    fact_key: 'fact.lang.french.reading_writing',
    fact_type: 'SKILL',
    statement: 'French language proficiency: reading and writing capability; no meaningful spoken fluency.',
    structured_value: {
      capability_family: 'LANGUAGES_GEOGRAPHY',
      language: 'French',
      speaking: 'NONE',
      reading: 'READING_WRITING',
      writing: 'READING_WRITING',
      proficiency: 'FOUNDATIONAL',
      interest: 'SUPPORTING',
      evidence_strength: 'COURSE_PROJECT',
      recency: 'HISTORICAL',
      development_status: 'CURRENT',
    },
    evidence_tier: 'COURSE_PROJECT',
    verification_status: 'SELF_ATTESTED',
    is_current: false,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.profile'],
  });

  addFact({
    fact_key: 'fact.lang.korean.basic',
    engagement_key: 'english_village.cognitive_linguistics_facilitator',
    fact_type: 'SKILL',
    statement: 'Korean language proficiency: basic reading and writing (Hangul); very limited speaking.',
    structured_value: {
      capability_family: 'LANGUAGES_GEOGRAPHY',
      language: 'Korean',
      speaking: 'VERY_LIMITED',
      reading: 'BASIC',
      writing: 'BASIC',
      proficiency: 'FOUNDATIONAL',
      interest: 'SUPPORTING',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'HISTORICAL',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2006-03-01',
    end_date: '2007-02-28',
    is_current: false,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.profile'],
  });

  addFact({
    fact_key: 'fact.geo.regional_familiarity',
    engagement_key: 'mondelez.regional_crm_sfa_architect',
    fact_type: 'DOMAIN',
    statement: 'Professional regional familiarity across China, Singapore, Korea, US, Russia, Netherlands, Australia, Indonesia, Malaysia, Philippines, Thailand, Vietnam, and Japan.',
    structured_value: {
      capability_family: 'LANGUAGES_GEOGRAPHY',
      region: 'APAC, North America & Europe',
      familiarity: 'Multi-jurisdictional professional delivery and stakeholder engagement',
      proficiency: 'ADVANCED',
      interest: 'TARGET',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2008-05-01',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.profile'],
  });

  // ==========================================================================
  // 14. SIGNATURE STRENGTHS
  // ==========================================================================
  addFact({
    fact_key: 'fact.strength.exceptional_pattern_recognition',
    fact_type: 'SKILL',
    statement: 'Exceptional pattern recognition: rapidly identifying systemic similarities, structural invariants, and emergent connections across disparate disciplines.',
    structured_value: {
      capability_family: 'SIGNATURE_STRENGTHS',
      strength_key: 'exceptional_pattern_recognition',
      display_label: 'Exceptional Pattern Recognition',
      proficiency: 'EXPERT',
      interest: 'TARGET',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.interview.stage1'],
  });

  addFact({
    fact_key: 'fact.strength.exceptional_systems_thinking',
    fact_type: 'SKILL',
    statement: 'Exceptional systems thinking: analyzing multi-tier feedback loops, institutional incentives, and end-to-end technical dynamics.',
    structured_value: {
      capability_family: 'SIGNATURE_STRENGTHS',
      strength_key: 'exceptional_systems_thinking',
      display_label: 'Exceptional Systems Thinking',
      proficiency: 'EXPERT',
      interest: 'TARGET',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.interview.stage1'],
  });

  addFact({
    fact_key: 'fact.strength.complex_process_decomposition',
    fact_type: 'SKILL',
    statement: 'Complex process decomposition: breaking chaotic, unstructured enterprise problems into clear requirements, architectures, and roadmaps.',
    structured_value: {
      capability_family: 'SIGNATURE_STRENGTHS',
      strength_key: 'complex_process_decomposition',
      display_label: 'Complex Process Decomposition',
      proficiency: 'EXPERT',
      interest: 'TARGET',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.interview.stage1'],
  });

  addFact({
    fact_key: 'fact.strength.chaos_to_order_transformation',
    fact_type: 'SKILL',
    statement: 'Chaos-to-order transformation: signature operating pattern of taking ambiguous, under-specified situations and establishing structure, architecture, and repeatable delivery.',
    structured_value: {
      capability_family: 'SIGNATURE_STRENGTHS',
      strength_key: 'chaos_to_order_transformation',
      display_label: 'Chaos-to-Order Transformation',
      proficiency: 'EXPERT',
      interest: 'TARGET',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.interview.stage1'],
  });

  addFact({
    fact_key: 'fact.strength.autonomous_ownership',
    fact_type: 'SKILL',
    statement: 'Autonomous ownership: driving solutions independently with minimal supervision, solving blockers forensically, and maintaining high accountability.',
    structured_value: {
      capability_family: 'SIGNATURE_STRENGTHS',
      strength_key: 'autonomous_ownership',
      display_label: 'Autonomous Ownership & Forensic Analysis',
      proficiency: 'EXPERT',
      interest: 'TARGET',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'CURRENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    is_current: true,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.interview.stage1'],
  });

  // ==========================================================================
  // 15. ATOMIC PROOF POINTS & ACHIEVEMENTS
  // ==========================================================================
  addFact({
    fact_key: 'fact.proof.ylf_irex_us_scholarship',
    fact_type: 'ACHIEVEMENT',
    statement: 'Selected for the highly competitive Young Leaders Fellowship (IREX / US Department of State), completing one year of leadership and academic study in the United States.',
    structured_value: {
      capability_family: 'TECHNICAL_DELIVERY',
      display_label: 'IREX / US State Dept YLF Fellowship',
      proficiency: 'EXPERT',
      interest: 'SUPPORTING',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'HISTORICAL',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'VERIFIED',
    start_date: '2004-01-01',
    end_date: '2005-01-01',
    is_current: false,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.profile'],
  });

  addFact({
    fact_key: 'fact.proof.wealth_portfolio_30m.self_attested',
    engagement_key: 'financial_alliance.senior_consultant',
    fact_type: 'ACHIEVEMENT',
    statement: 'Built and advised an investment advisory portfolio of approximately SGD 30M in high-net-worth client assets across multi-asset funds and discretionary mandates.',
    structured_value: {
      capability_family: 'DOMAIN_EXPERTISE',
      display_label: 'SGD 30M Advisory Portfolio Built',
      portfolio_sgd: 30000000,
      proficiency: 'EXPERT',
      interest: 'SUPPORTING',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'HISTORICAL',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2017-07-01',
    end_date: '2019-07-31',
    is_current: false,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.profile'],
  });

  addFact({
    fact_key: 'fact.proof.robo_advisory_21_platforms_research',
    engagement_key: 'synpulse.algorithmic_wealth_researcher',
    fact_type: 'PUBLICATION',
    statement: 'Researched and authored comparative market audit covering 21 digital wealth and robo-advisory platforms across Hong Kong and Singapore for Synpulse Management Consulting.',
    structured_value: {
      capability_family: 'RESEARCH',
      display_label: '21 Digital Wealth Platforms Market Audit',
      platforms_audited: 21,
      proficiency: 'EXPERT',
      interest: 'STRONG',
      evidence_strength: 'PROFESSIONAL_PRODUCTION',
      recency: 'RECENT',
      development_status: 'CURRENT',
    },
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    start_date: '2017-08-01',
    end_date: '2018-01-31',
    is_current: false,
    confidentiality: 'PUBLIC',
    evidence_source_keys: ['src.profile'],
  });

  return facts;
}

export function saveStage1Facts(targetPath = 'private/profile/facts.json') {
  const existingRaw = fs.readFileSync(targetPath, 'utf-8');
  const existingData = JSON.parse(existingRaw);

  const newFactsList = buildStage1Facts();
  const newFactsMap = new Map(newFactsList.map((f) => [f.fact_key, f]));

  // Merge: for facts already existing in existingData, enrich them with standardized metadata
  // and keep new ones added
  const mergedFacts = [];
  const handledKeys = new Set<string>();

  for (const existingFact of existingData.facts) {
    handledKeys.add(existingFact.fact_key);
    if (newFactsMap.has(existingFact.fact_key)) {
      // Overwrite/enrich with new Stage 1 structured definition
      mergedFacts.push(newFactsMap.get(existingFact.fact_key)!);
    } else {
      // Enrich existing fact with default standardized metadata based on its type and tier
      const meta = (existingFact.structured_value || {}) as Record<string, any>;
      if (!meta.proficiency) {
        meta.proficiency = existingFact.evidence_tier === 'PROFESSIONAL_PRODUCTION' ? 'ADVANCED' : 'INDEPENDENT';
      }
      if (!meta.hands_on_level) {
        meta.hands_on_level = existingFact.evidence_tier === 'PROFESSIONAL_PRODUCTION' ? 'PRODUCTION' : 'APPLIED_PROJECT';
      }
      if (!meta.interest) {
        meta.interest = 'STRONG';
      }
      if (!meta.evidence_strength) {
        meta.evidence_strength = existingFact.evidence_tier;
      }
      if (!meta.recency) {
        meta.recency = existingFact.is_current ? 'CURRENT' : 'HISTORICAL';
      }
      if (!meta.development_status) {
        meta.development_status = 'CURRENT';
      }
      if (!meta.capability_family) {
        if (existingFact.fact_type === 'DOMAIN') meta.capability_family = 'DOMAIN_EXPERTISE';
        else if (existingFact.fact_type === 'TECHNOLOGY') meta.capability_family = 'SOFTWARE_ENGINEERING';
        else if (existingFact.fact_type === 'PROJECT') meta.capability_family = 'TECHNICAL_DELIVERY';
        else meta.capability_family = 'TECHNICAL_DELIVERY';
      }
      existingFact.structured_value = meta;
      mergedFacts.push(existingFact);
    }
  }

  // Add new facts not in existing
  for (const newFact of newFactsList) {
    if (!handledKeys.has(newFact.fact_key)) {
      mergedFacts.push(newFact);
    }
  }

  const output = {
    schema_version: '2.0',
    profile_key: existingData.profile_key || 'candidate_alpha',
    facts: mergedFacts,
  };

  // Validate with Zod schema
  FactJsonSchema.parse(output);

  fs.writeFileSync(targetPath, JSON.stringify(output, null, 2) + '\n');
  console.log(`Saved ${mergedFacts.length} validated Stage 1 facts to ${targetPath}`);
  return output;
}

if (process.argv[1]?.endsWith('build_stage1_facts.ts') || process.argv[1]?.endsWith('build_stage1_facts.js')) {
  saveStage1Facts();
}
