terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# Primary region for all resources
provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = var.app_name
      ManagedBy = "terraform"
    }
  }
}

# ACM certificates for CloudFront MUST be provisioned in us-east-1
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      Project   = var.app_name
      ManagedBy = "terraform"
    }
  }
}

# Look up the existing Route53 hosted zone
data "aws_route53_zone" "zone" {
  name         = var.route53_zone_name
  private_zone = false
}

data "aws_caller_identity" "current" {}
