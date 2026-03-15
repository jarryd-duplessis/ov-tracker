output "app_url" {
  description = "Live application URL"
  value       = "https://${var.domain_name}"
}

output "cloudfront_domain" {
  description = "CloudFront domain (useful before DNS propagates)"
  value       = aws_cloudfront_distribution.main.domain_name
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID (needed for cache invalidations)"
  value       = aws_cloudfront_distribution.main.id
}

output "alb_dns_name" {
  description = "ALB DNS name — useful for debugging backend directly"
  value       = aws_lb.backend.dns_name
}

output "ecr_repository_url" {
  description = "ECR repository URL for the backend Docker image"
  value       = aws_ecr_repository.backend.repository_url
}

output "s3_bucket_name" {
  description = "S3 bucket name for frontend static files"
  value       = aws_s3_bucket.frontend.bucket
}

output "ecs_cluster_name" {
  description = "ECS cluster name"
  value       = aws_ecs_cluster.main.name
}

output "ecs_service_name" {
  description = "ECS service name"
  value       = aws_ecs_service.backend.name
}

output "deploy_commands" {
  description = "Commands to build and deploy after terraform apply"
  value       = <<-EOT

    ── BACKEND ──────────────────────────────────────────────────────────────
    cd backend

    # Authenticate Docker to ECR
    aws ecr get-login-password --region ${var.aws_region} | \
      docker login --username AWS --password-stdin ${aws_ecr_repository.backend.repository_url}

    # Build and push (use --platform flag if building on Apple Silicon)
    docker build --platform linux/amd64 -t ${aws_ecr_repository.backend.repository_url}:latest .
    docker push ${aws_ecr_repository.backend.repository_url}:latest

    # Force ECS to pick up the new image
    aws ecs update-service \
      --cluster ${aws_ecs_cluster.main.name} \
      --service ${aws_ecs_service.backend.name} \
      --force-new-deployment \
      --region ${var.aws_region}

    ── FRONTEND ─────────────────────────────────────────────────────────────
    cd frontend
    npm run build

    aws s3 sync dist/ s3://${aws_s3_bucket.frontend.bucket}/ --delete

    # Bust CloudFront cache so users get the new build immediately
    aws cloudfront create-invalidation \
      --distribution-id ${aws_cloudfront_distribution.main.id} \
      --paths "/*"

    ── DONE ─────────────────────────────────────────────────────────────────
    Visit: https://${var.domain_name}
  EOT
}
