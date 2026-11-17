# Deploying the secured backend

The whole backend is defined in [`template.yaml`](template.yaml) (CloudFormation), so it can be
reviewed in git and recreated exactly. No AWS CLI is needed; everything below is done in the
AWS console (region **us-east-2 / Ohio**) and on GitHub.

| What the stack creates | Checklist § |
|---|---|
| Cognito user pool, sign-in domain and app client (authorization code + PKCE, 1-hour tokens) | 1 |
| HTTP API with a **JWT authorizer on every route**, throttling (10 req/s, burst 20), CORS limited to the app origin, access logs | 1, 5, 6, 8 |
| Lambda `smm-api-secure` with its **own least-privilege role** (5 DynamoDB actions on 2 tables + its log group) | 2 |
| Tables `SMM_UserTransactions` (PK `userId`, SK `id`) and `SMM_UserBudget` (PK `userId`), with PITR, encryption and deletion protection | 1, 8 |
| CloudWatch alarms (Lambda errors/throttles, API 5xx, 4xx spike), SNS email alerts, AWS Budget alert | 5, 8 |
| GitHub OIDC deploy role that can **only** update this one Lambda, and only from `master` | 10 |

**Cost:** all of these fit in the AWS Free Tier at student scale. PITR is billed per GB of
table data, so at a few KB it rounds to $0.00. The Budget alert emails you if spend passes
80% of `MonthlyBudgetUSD`.

---

## 1. Create the stack

1. AWS console → **CloudFormation** → *Create stack* → *With new resources* → *Upload a template file*
   → choose `aws/template.yaml`.
2. Stack name: `smm-secure`. Parameters:
   - **AppOrigin**: your Amplify URL with no trailing slash, e.g. `https://master.d1abc23.amplifyapp.com`
     (Amplify console → your app → *Domain*).
   - **CognitoDomainPrefix**: something unique, e.g. `smm-<yourname>-2026`.
   - **AlertEmail**: your email (strongly recommended).
   - **CreateGitHubOidcProvider**: `true`, unless IAM → *Identity providers* already lists
     `token.actions.githubusercontent.com`.
   - Leave the rest at their defaults.
3. Tick **"I acknowledge that AWS CloudFormation might create IAM resources with custom names"**
   and create the stack.
4. When it reaches `CREATE_COMPLETE`, open the **Outputs** tab. You need these values in steps 3 and 4.
5. Confirm the SNS subscription email AWS sends you.

## 2. (Optional) Turn on MFA for your own account

The pool allows optional TOTP MFA. After signing up, you can enable it from the Cognito console.

## 3. Deploy the Lambda code from GitHub

In the GitHub repo → *Settings* → *Secrets and variables* → *Actions* → **Variables** tab, add:

| Variable | Value (stack output) |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | `GitHubDeployRoleArn` |
| `LAMBDA_FUNCTION_NAME` | `LambdaFunctionName` |

Then go to *Actions* → **Deploy Lambda** → *Run workflow*. Every later push to `master` that changes
`aws/lambda/**` redeploys automatically. Never paste code into the Lambda console again.

## 4. Point the frontend at the new backend

Edit [`config.js`](../config.js) with the outputs `ApiUrl`, `CognitoDomain` and
`UserPoolClientId`, then commit and push. Amplify redeploys, and the site shows a
**Sign in** screen.

## 5. Remove the old, unauthenticated backend

The old API stays publicly readable and writable until you delete it:

1. **API Gateway** → delete the HTTP API `smm-api`.
2. **Lambda** → delete the function `smmApi`.
3. **DynamoDB** → delete `SMM_Transactions` and `SMM_Budget`. Export anything you want to keep
   first. Anyone on the internet could write to these tables, so treat their contents as untrusted.
4. **IAM** → if `PowerUserRole` was used only by `smmApi`, delete it. Otherwise make sure no Lambda
   uses it.

## 6. Verify

Run the **Test** items in [`checklist.md`](../checklist.md). Quick checks:

```bash
API=<ApiUrl>
curl -i $API/transactions                                   # expect 401
curl -i -H "Origin: https://evil.example" -X OPTIONS $API/transactions \
     -H "Access-Control-Request-Method: GET"                 # no Access-Control-Allow-Origin for evil.example
curl -sI https://<your-amplify-domain>/ | grep -iE "content-security|strict-transport|x-frame|nosniff"
curl -s -o /dev/null -w "%{http_code}\n" https://<your-amplify-domain>/aws/lambda/index.mjs   # expect 404
```
