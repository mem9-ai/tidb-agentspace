const regionLabels: Record<string, string> = {
  automatic: 'Automatic',
  'aws-us-east-1': 'AWS · N. Virginia',
  'aws-us-west-2': 'AWS · Oregon',
  'aws-ap-southeast-1': 'AWS · Singapore',
  'region:local': 'Local',
};

export function regionLabel(code: string): string {
  return regionLabels[code] ?? code;
}
