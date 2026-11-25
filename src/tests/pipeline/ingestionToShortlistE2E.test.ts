import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { evaluateHardGates } from '../../services/criteria.js';

describe('End-to-End Funnel & Gate Verification Suite', () => {
  it('should reject HR and Executive Assistant roles deterministically', () => {
    const hrResult = evaluateHardGates(
      'Human Resources Manager',
      'Manage payroll, hiring, and office operations.',
      'Singapore',
      'Hybrid'
    );
    expect(hrResult.passed).toBe(false);
    expect(hrResult.reasonCode).toBe('NON_TARGET_ROLE_FAMILY');

    const eaResult = evaluateHardGates(
      'Executive Assistant & Office Manager',
      'Calendar management and booking flights.',
      'Singapore',
      'On-site'
    );
    expect(eaResult.passed).toBe(false);
    expect(eaResult.reasonCode).toBe('NON_TARGET_ROLE_FAMILY');
  });

  it('should pass Quantitative Engineer through deterministic prequalification', () => {
    const quantResult = evaluateHardGates(
      'Senior Quantitative Developer',
      'Develop low-latency C++ and Python algorithmic trading systems for market microstructure. Hybrid with 2 days per week in office.',
      'Singapore',
      'Hybrid'
    );
    expect(quantResult.passed).toBe(true);
    expect(quantResult.axis1FunctionPassed).toBe(true);

  });

  it('should reject on-site only laboratory positions', () => {
    const labResult = evaluateHardGates(
      'Senior Bioinformatician',
      'Must work 100% on-site in the wet lab pipetting samples.',
      'Singapore',
      'On-site'
    );
    expect(labResult.passed).toBe(false);
    expect(labResult.reasonCode).toBe('UNWORKABLE_LOCATION_MODEL');
  });

  it('should reject unspecified workplace conditions deterministically', () => {
    const unknownResult = evaluateHardGates(
      'Backend AI Engineer',
      'Build scalable Python and PostgreSQL distributed systems.',
      'Singapore',
      ''
    );
    expect(unknownResult.passed).toBe(false);
    expect(unknownResult.needsVerification).toBe(true);
    expect(unknownResult.reasonCode).toBe('GATE_UNKNOWN_WORK_MODE');
  });

  it('should pass Data Engineer with technical function verified', () => {
    const dataEngResult = evaluateHardGates(
      'Data Engineer',
      'Design and build Python-based ETL pipelines using PostgreSQL and Apache Spark.',
      'Remote',
      'Remote'
    );
    expect(dataEngResult.passed).toBe(true);
    expect(dataEngResult.axis1FunctionPassed).toBe(true);
    expect(dataEngResult.needsVerification).toBe(false);
  });

  it('should reject non-technical QA coordinator roles', () => {
    const qaResult = evaluateHardGates(
      'QA Coordinator',
      'Manual testing and quality assurance coordination for desktop applications.',
      'Singapore',
      'Remote'
    );
    expect(qaResult.passed).toBe(false);
    // QA and testing titles are a deterministic non-target role-family exclusion (owner policy 2026-11-22);
    // the generic Axis-1 technical check is no longer a hard gate.
    expect(qaResult.reasonCode).toBe('NON_TARGET_ROLE_FAMILY');
  });

  it('does not reject a bare presales phrase (gate-2026-11.7); explicit sales-target evidence still rejects', () => {
    const bare = evaluateHardGates(
      'Solutions Engineer (Sales)',
      'Customer relationship management and presales activities.',
      'Remote',
      'Remote'
    );
    expect(bare.reasonCode).not.toBe('GATE_HIGH_INTERACTION');
    const explicit = evaluateHardGates(
      'Solutions Engineer (Sales)',
      'You will carry a quarterly sales quota and do outbound prospecting.',
      'Remote',
      'Remote'
    );
    expect(explicit.passed).toBe(false);
    expect(explicit.reasonCode).toBe('GATE_HIGH_INTERACTION');
  });

});
