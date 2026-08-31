output "app_url" {
  description = "Open this in a browser."
  value       = "https://${aws_cloudfront_distribution.web.domain_name}"
}

output "distribution_id" {
  value = aws_cloudfront_distribution.web.id
}

output "function_url" {
  description = "Only useful via CloudFront — a direct hit lacks the x-origin-secret header and gets 403."
  value       = aws_lambda_function_url.api.function_url
}

output "bucket" {
  value = aws_s3_bucket.web.bucket
}
