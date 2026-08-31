terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.2"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

# Credentials come from the environment. The `admin` profile is a login-session
# profile that the AWS Go SDK (this provider) can't read directly, so `deploy.sh`
# exports it via `aws configure export-credentials` before invoking tofu. The
# raw `aws` CLI *can* read the profile, so the invalidation local-exec still
# passes `--profile var.aws_profile`.
provider "aws" {
  region = var.aws_region
}

data "aws_caller_identity" "current" {}
