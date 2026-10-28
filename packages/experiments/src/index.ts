/**
 * Two-arm conversion analysis; no hidden causal claims.
 * Statistical significance is only meaningful for a randomized, valid
 * experiment with correct exposure/outcome attribution and analysis plan.
 */
export interface ArmCounts{variant:string;exposed:number;converted:number}
export type ExperimentStatus =
  "insufficient_data" | "sample_ratio_mismatch" | "no_detected_difference" | "difference_detected";
export interface ExperimentAnalysis{
  control:ArmCounts;treatment:ArmCounts;
  controlRate:number;treatmentRate:number;
  absoluteDifference:number;relativeLift:number|null;
  confidenceInterval95:[number,number];
  pValueTwoSided:number;
  sampleRatioPValue:number;
  status:ExperimentStatus;
  randomizedAssignmentProven:false;
  causalClaim:false;
  caveats:string[];
}
export class ExperimentError extends Error{
  constructor(readonly code:string){super(code);this.name="ExperimentError";}
}
function normalCdf(x:number):number{
  // Abramowitz and Stegun 7.1.26; sufficient precision for display.
  const abs=Math.abs(x)/Math.SQRT2;
  const t=1/(1+.3275911*abs);
  const erf=1-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-
    .284496736)*t+.254829592)*t*Math.exp(-abs*abs);
  return Math.max(0,Math.min(1,(1+(x>=0?erf:-erf))/2));
}
function wilson(p:number,n:number):[number,number]{
  if(n===0)return [0,1];
  const z=1.959963984540054,z2=z*z,denom=1+z2/n;
  const center=(p+z2/(2*n))/denom;
  const margin=z*Math.sqrt((p*(1-p)+z2/(4*n))/n)/denom;
  return [Math.max(0,center-margin),Math.min(1,center+margin)];
}
function validateArm(arm:ArmCounts):void{
  if(!arm||typeof arm.variant!=="string"||!/^[A-Za-z0-9_-]{1,60}$/.test(arm.variant)||
    !Number.isSafeInteger(arm.exposed)||!Number.isSafeInteger(arm.converted)||
    arm.exposed<0||arm.converted<0||arm.converted>arm.exposed)
    throw new ExperimentError("invalid_arm_counts");
}
export function analyzeExperiment(control:ArmCounts,treatment:ArmCounts):ExperimentAnalysis{
  validateArm(control);validateArm(treatment);
  if(control.variant===treatment.variant)throw new ExperimentError("same_variant");
  const n0=control.exposed,n1=treatment.exposed,x0=control.converted,x1=treatment.converted;
  const p0=n0?x0/n0:0,p1=n1?x1/n1:0,delta=p1-p0;
  const total=n0+n1;
  const pooled=total?(x0+x1)/total:0;
  const standardError=n0&&n1?Math.sqrt(pooled*(1-pooled)*(1/n0+1/n1)):0;
  const z=standardError>0?delta/standardError:0;
  const pValue=2*(1-normalCdf(Math.abs(z)));
  const chiSquare=total?((n0-total/2)**2+(n1-total/2)**2)/(total/2):0;
  const ratioP=2*(1-normalCdf(Math.sqrt(chiSquare)));
  const [l0,u0]=wilson(p0,n0),[l1,u1]=wilson(p1,n1);
  const low=delta-Math.sqrt((p1-l1)**2+(u0-p0)**2);
  const high=delta+Math.sqrt((u1-p1)**2+(p0-l0)**2);
  const insufficient=n0<100||n1<100||x0+x1<30;
  const mismatch=ratioP<.01;
  const detects=low>0||high<0;
  const status:ExperimentStatus=insufficient?"insufficient_data":
    mismatch?"sample_ratio_mismatch":detects?"difference_detected":"no_detected_difference";
  return {
    control,treatment,controlRate:p0,treatmentRate:p1,
    absoluteDifference:delta,relativeLift:p0>0?delta/p0:null,
    confidenceInterval95:[low,high],pValueTwoSided:pValue,
    sampleRatioPValue:ratioP,status,
    randomizedAssignmentProven:false,causalClaim:false,
    caveats:[
      "Exposure-based counts are not proof of randomized assignment or causal effects.",
      "The sample-ratio diagnostic assumes a 50/50 expected allocation, which must be confirmed against Flagship.",
      "Repeated monitoring can inflate false positives; a preregistered analysis plan is required for inference.",
      "Missing identity joins, delayed outcomes, sampling and selection bias can invalidate this comparison."
    ],
  };
}
