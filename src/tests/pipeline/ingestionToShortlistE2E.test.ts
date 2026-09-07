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

  it('should yield NEEDS_VERIFICATION for unspecified location conditions', () => {
    const unknownResult = evaluateHardGates(
      'Backend AI Engineer',
      'Build scalable Python and PostgreSQL distributed systems.',
      'Singapore',
      ''
    );
    expect(unknownResult.passed).toBe(false);
    expect(unknownResult.needsVerification).toBe(true);
    expect(unknownResult.reasonCode).toBe('NEEDS_VERIFICATION');
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
    expect(qaResult.reasonCode).toBe('NON_TECHNICAL_FUNCTION');
  });

  it('should reject sales engineer / presales roles that lack hands-on building', () => {
    const salesResult = evaluateHardGates(
      'Solutions Engineer (Sales)',
      'Customer relationship management and presales activities.',
      'Remote',
      'Remote'
    );
    expect(salesResult.passed).toBe(false);
  });

});
