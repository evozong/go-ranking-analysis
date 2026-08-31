locals {
  web_dir = "${path.module}/../web/dist"

  mime = {
    ".html"        = "text/html"
    ".js"          = "application/javascript"
    ".mjs"         = "application/javascript"
    ".css"         = "text/css"
    ".map"         = "application/json"
    ".json"        = "application/json"
    ".svg"         = "image/svg+xml"
    ".ico"         = "image/x-icon"
    ".png"         = "image/png"
    ".jpg"         = "image/jpeg"
    ".webp"        = "image/webp"
    ".woff2"       = "font/woff2"
    ".txt"         = "text/plain"
    ".webmanifest" = "application/manifest+json"
  }
}

# `npm run build -w web` must have produced web/dist (the root `npm run deploy`
# script runs `npm run build` first).
resource "aws_s3_object" "web" {
  for_each = fileset(local.web_dir, "**")

  bucket       = aws_s3_bucket.web.id
  key          = each.value
  source       = "${local.web_dir}/${each.value}"
  etag         = filemd5("${local.web_dir}/${each.value}")
  content_type = lookup(local.mime, try(lower(regex("\\.[^./]+$", each.value)), ""), "application/octet-stream")
}

# Bust the CDN cache for changed deploys. `/*` is well within the always-free
# 1,000 invalidation paths/month.
resource "null_resource" "invalidate" {
  triggers = {
    files = sha1(join(",", [for f in fileset(local.web_dir, "**") : filemd5("${local.web_dir}/${f}")]))
  }

  provisioner "local-exec" {
    command = "aws cloudfront create-invalidation --distribution-id ${aws_cloudfront_distribution.web.id} --paths '/*' --profile ${var.aws_profile} --region ${var.aws_region}"
  }

  depends_on = [aws_s3_object.web]
}
