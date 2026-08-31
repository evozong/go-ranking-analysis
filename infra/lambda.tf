# --- package -----------------------------------------------------------------
# `npm run build:lambda -w server` must have produced server/dist-lambda/index.mjs
# (the root `npm run deploy` script does this before `tofu apply`).
data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = "${path.module}/../server/dist-lambda"
  output_path = "${path.module}/lambda.zip"
}

# --- role ------------------------------------------------------------------------
data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  name               = "${var.name}-api"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "lambda_logs" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${var.name}-api"
  retention_in_days = 14
}

# --- function ------------------------------------------------------------------
resource "aws_lambda_function" "api" {
  function_name    = "${var.name}-api"
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  memory_size      = 512
  timeout          = 30

  environment {
    variables = {
      APP_ENV           = "prd"
      PGUSER            = var.pg_user
      PGDATABASE        = var.pg_database
      PGHOST_PRD        = var.pg_host_prd
      PGHOST_POOLED_PRD = var.pg_host_pooled_prd
      PGPASSWORD_PRD    = var.pg_password_prd
      PG_POOL_MAX       = "2"
      # The app rejects any request without this header. CloudFront injects it on
      # every origin request (see the lambda origin's custom_header); a direct
      # hit to the *.lambda-url host lacks it and gets 403.
      ORIGIN_SECRET = random_password.origin_secret.result
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.lambda_logs,
    aws_cloudwatch_log_group.lambda,
  ]
}

# Shared secret CloudFront injects as a request header; the app requires it.
resource "random_password" "origin_secret" {
  length  = 40
  special = false
}

# authorization_type = NONE, not AWS_IAM + OAC: CloudFront OAC only signs GET/HEAD
# origin requests, so signed POST/PUT bodies fail the Function URL's SigV4 check
# (the app's file upload would always 403). The Function URL is instead cloaked
# by the ORIGIN_SECRET header check in the app.
resource "aws_lambda_function_url" "api" {
  function_name      = aws_lambda_function.api.function_name
  authorization_type = "NONE"
}

# A public (NONE) Function URL still needs a resource policy granting access.
# Since October 2025 that means BOTH lambda:InvokeFunctionUrl AND
# lambda:InvokeFunction for principal "*" — without the second one every request
# gets a Function-URL-authorization 403. Terraform/AWS do not add either
# automatically. Actual access is still gated by the x-origin-secret check in the
# app (a bare `aws lambda invoke` reaches the handler and gets 403 without it).
resource "aws_lambda_permission" "public_function_url" {
  statement_id           = "AllowPublicFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.api.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

resource "aws_lambda_permission" "public_function_invoke" {
  statement_id  = "AllowPublicFunctionInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "*"
}
