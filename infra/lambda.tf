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
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.lambda_logs,
    aws_cloudwatch_log_group.lambda,
  ]
}

# Private Function URL: only the CloudFront distribution can call it (SigV4 via
# the lambda OAC + the permission below). Direct hits to the *.lambda-url host 403.
resource "aws_lambda_function_url" "api" {
  function_name      = aws_lambda_function.api.function_name
  authorization_type = "AWS_IAM"
}

resource "aws_lambda_permission" "cloudfront_invoke_url" {
  statement_id           = "AllowCloudFrontInvokeFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.api.function_name
  principal              = "cloudfront.amazonaws.com"
  source_arn             = aws_cloudfront_distribution.web.arn
  function_url_auth_type = "AWS_IAM"
}

# Since October 2025 AWS also requires plain lambda:InvokeFunction for the
# CloudFront principal — Function URLs created after that date 403 without it
# even when InvokeFunctionUrl is granted.
resource "aws_lambda_permission" "cloudfront_invoke" {
  statement_id  = "AllowCloudFrontInvokeFunction"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "cloudfront.amazonaws.com"
  source_arn    = aws_cloudfront_distribution.web.arn
}
