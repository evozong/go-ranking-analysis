variable "aws_region" {
  description = "Region for the Lambda + S3 bucket (CloudFront is global). Matches the Neon project region."
  type        = string
  default     = "us-west-2"
}

variable "aws_profile" {
  description = "awscli profile for the CloudFront invalidation local-exec. (Provider creds come from the env via deploy.sh.)"
  type        = string
  default     = "admin"
}

variable "name" {
  description = "Base name for all resources."
  type        = string
  default     = "go-ranking-analysis"
}

variable "pg_user" {
  description = "Neon role. Same across branches; from server/.env.defaults."
  type        = string
  default     = "neondb_owner"
}

variable "pg_database" {
  description = "Neon database name. From server/.env.defaults."
  type        = string
  default     = "neondb"
}

variable "pg_host_prd" {
  description = "Neon prd branch DIRECT host (ep-...-<id>.<region>.aws.neon.tech)."
  type        = string
  sensitive   = true
}

variable "pg_host_pooled_prd" {
  description = "Neon prd branch POOLED host (ep-...-<id>-pooler.<region>.aws.neon.tech). Used at runtime."
  type        = string
  sensitive   = true
}

variable "pg_password_prd" {
  description = "Neon prd branch role password."
  type        = string
  sensitive   = true
}
