const regionLabels: Record<string, string> = {
  automatic: 'Assigned by the database provider',
  'aws-us-east-1': 'AWS · N. Virginia',
  'aws-us-west-2': 'AWS · Oregon',
  'aws-ap-southeast-1': 'AWS · Singapore',
};

export function regionLabel(code: string): string {
  return regionLabels[code] ?? code;
}
