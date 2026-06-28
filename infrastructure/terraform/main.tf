terraform {
  required_version = ">= 1.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

variable "aws_region" {
  description = "AWS region for deployment"
  type        = string
  default     = "eu-central-1"
}

variable "environment" {
  description = "Environment name (e.g., dev, staging, prod)"
  type        = string
  default     = "dev"
}

variable "project_name" {
  description = "Project name used for resource naming"
  type        = string
  default     = "enterprise-sync"
}

locals {
  name_prefix = "${var.project_name}-${var.environment}"
}

# S3 Bucket for transaction files storage
resource "aws_s3_bucket" "transaction_storage" {
  bucket = "${local.name_prefix}-transactions"

  tags = {
    Name        = "${local.name_prefix}-transactions"
    Environment = var.environment
    Project     = var.project_name
  }
}

resource "aws_s3_bucket_versioning" "transaction_storage_versioning" {
  bucket = aws_s3_bucket.transaction_storage.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "transaction_storage_pab" {
  bucket = aws_s3_bucket.transaction_storage.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# RDS PostgreSQL - Placeholder for future implementation
# resource "aws_db_instance" "postgresql" {
#   identifier        = "${local.name_prefix}-postgres"
#   engine            = "postgres"
#   engine_version    = "16.4"
#   instance_class    = "db.t3.medium"
#   allocated_storage = 100
#   storage_type      = "gp3"
#
#   db_name  = "enterprise_db"
#   username = var.db_username
#   password = var.db_password
#
#   multi_az               = true
#   publicly_accessible    = false
#   vpc_security_group_ids = [aws_security_group.database.id]
#   db_subnet_group_name   = aws_db_subnet_group.main.name
#
#   backup_retention_period = 7
#   deletion_protection     = true
#
#   tags = {
#     Name        = "${local.name_prefix}-postgres"
#     Environment = var.environment
#   }
# }

# ElastiCache Redis - Placeholder for future implementation
# resource "aws_elasticache_replication_group" "redis" {
#   replication_group_id       = "${local.name_prefix}-redis"
#   description                = "Redis cluster for ${var.project_name}"
#   node_type                  = "cache.t3.medium"
#   num_cache_clusters         = 2
#   automatic_failover_enabled = true
#   multi_az_enabled           = true
#
#   engine         = "redis"
#   engine_version = "7.2"
#
#   subnet_group_name  = aws_elasticache_subnet_group.redis.name
#   security_group_ids = [aws_security_group.redis.id]
#
#   at_rest_encryption_enabled = true
#   transit_encryption_enabled = true
#   auth_token                 = var.redis_auth_token
#
#   tags = {
#     Name        = "${local.name_prefix}-redis"
#     Environment = var.environment
#   }
# }

# Amazon MQ (RabbitMQ) - Placeholder for future implementation
# resource "aws_mq_broker" "rabbitmq" {
#   broker_name = "${local.name_prefix}-rabbitmq"
#   engine_type = "RabbitMQ"
#   engine_version = "3.13"
#   host_instance_type = "mq.m5.large"
#   deployment_mode = "CLUSTER_MULTI_AZ"
#
#   subnet_ids = aws_subnet.private[*].id
#   security_groups = [aws_security_group.mq.id]
#
#   user {
#     username = var.mq_username
#     password = var.mq_password
#   }
#
#   encrypted = true
#
#   tags = {
#     Name        = "${local.name_prefix}-rabbitmq"
#     Environment = var.environment
#   }
# }

# Variables for sensitive data (to be provided via terraform.tfvars or AWS Secrets Manager)
variable "db_username" {
  description = "Database admin username"
  type        = string
  default     = "admin"
}

variable "db_password" {
  description = "Database admin password"
  type        = string
  sensitive   = true
}

variable "redis_auth_token" {
  description = "Redis auth token for encryption"
  type        = string
  sensitive   = true
}

variable "mq_username" {
  description = "Amazon MQ username"
  type        = string
  default     = "admin"
}

variable "mq_password" {
  description = "Amazon MQ password"
  type        = string
  sensitive   = true
}

output "s3_bucket_name" {
  description = "Name of the S3 bucket"
  value       = aws_s3_bucket.transaction_storage.id
}

output "s3_bucket_arn" {
  description = "ARN of the S3 bucket"
  value       = aws_s3_bucket.transaction_storage.arn
}
