import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

export async function approve({ projectRoot, planId, confirm, reason, approver = 'human' }) {
  try {
    if (!projectRoot) throw new Error('projectRoot is required');
    if (!planId) throw new Error('planId is required');

    const approvalsDir = path.join(projectRoot, '.rks', 'approvals');
    const approvalFilePath = path.join(approvalsDir, `${planId}.json`);

    // Read approval request
    let rawApproval;
    try {
      rawApproval = await fs.readFile(approvalFilePath, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        throw new Error(`approval file not found: ${approvalFilePath}`);
      }
      throw err;
    }

    let approval;
    try {
      approval = JSON.parse(rawApproval);
    } catch (err) {
      throw new Error('invalid approval file JSON');
    }

    // Ensure pending
    if (approval.status !== 'pending') {
      throw new Error(`approval already processed (status=${String(approval.status)})`);
    }

    if (!approval.planPath) throw new Error('approval file missing planPath');
    if (!approval.planHash) throw new Error('approval file missing planHash');

    // Resolve and read plan
    const planAbsPath = path.isAbsolute(approval.planPath)
      ? approval.planPath
      : path.join(projectRoot, approval.planPath);

    let planContent;
    try {
      planContent = await fs.readFile(planAbsPath, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        throw new Error(`plan file not found: ${planAbsPath}`);
      }
      throw err;
    }

    // Compute SHA256 of plan
    const computedHash = crypto.createHash('sha256').update(planContent, 'utf8').digest('hex');
    if (computedHash !== approval.planHash) {
      throw new Error('plan hash mismatch - plan changed since approval request');
    }

    const now = new Date().toISOString();

    // Apply approval or rejection
    if (confirm === true) {
      approval.status = 'approved';
      approval.approvedAt = now;
      approval.approvedBy = approver;
    } else if (confirm === false) {
      approval.status = 'rejected';
      approval.rejectedAt = now;
      approval.reason = reason || null;
      approval.approvedBy = approver;
    } else {
      throw new Error('confirm must be true or false');
    }

    // Ensure approvals dir exists and write updated approval file
    await fs.mkdir(approvalsDir, { recursive: true });
    await fs.writeFile(approvalFilePath, JSON.stringify(approval, null, 2), 'utf8');

    return { ok: true, status: approval.status, file: approval };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}
