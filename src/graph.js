import { confidenceForEvidence } from './confidence.js';

export class CodeNode {
  constructor({ id, name, type, file, ...properties }) {
    this.id = id;
    this.name = name;
    this.type = type;
    this.file = file;
    Object.assign(this, properties);
  }
}

export class CodeEdge {
  constructor({ source, target, relationship, evidence = 'static', confidence = confidenceForEvidence(evidence) }) {
    this.source = source;
    this.target = target;
    this.relationship = relationship;
    this.evidence = evidence;
    this.confidence = confidence;
  }
}
