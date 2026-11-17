'use strict';

/* Deployment configuration — fill in from the CloudFormation stack Outputs
   (see aws/README.md). None of these values are secrets. */
window.SMM_CONFIG = Object.freeze({
  apiBaseUrl: '',      // Output: ApiUrl            e.g. https://abc123.execute-api.us-east-2.amazonaws.com
  cognitoDomain: '',   // Output: CognitoDomain     e.g. https://smm-yourname.auth.us-east-2.amazoncognito.com
  cognitoClientId: '', // Output: UserPoolClientId
});
