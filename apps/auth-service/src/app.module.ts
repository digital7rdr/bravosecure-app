import {Module}           from '@nestjs/common';
import {ConfigModule}     from '@nestjs/config';
import {ThrottlerModule}  from '@nestjs/throttler';
import configuration      from './config/configuration';
import {DatabaseModule}   from './database/database.module';
import {RedisModule}      from './redis/redis.module';
import {KafkaModule}      from './kafka/kafka.module';
import {AuthModule}       from './auth/auth.module';
import {KeysModule}       from './keys/keys.module';
import {SenderCertModule} from './sender-cert/sender-cert.module';
import {TotpModule}       from './totp/totp.module';
import {BiometricModule}  from './biometric/biometric.module';
import {UsersModule}      from './users/users.module';
import {ConversationsModule} from './conversations/conversations.module';
import {BookingModule}       from './booking/booking.module';
import {WalletModule}        from './wallet/wallet.module';
import {TelemetryModule}     from './telemetry/telemetry.module';
import {AgentModule}         from './agents/agent.module';
import {OrgModule}           from './org/org.module';
import {AttendanceModule}    from './attendance/attendance.module';
import {IncidentModule}      from './incident/incident.module';
import {OpsModule}           from './ops/ops.module';
import {OpsDeptChatModule}   from './ops/ops-deptchat.module';
import {DispatchModule}      from './dispatch/dispatch.module';
import {ComplianceModule}    from './compliance/compliance.module';
import {SosModule}           from './sos/sos.module';
import {EventsModule}        from './events/events.module';
import {NotificationsModule} from './notifications/notifications.module';
import {VbgModule}           from './vbg/vbg.module';
import {FamilyModule}        from './family/family.module';
import {SubscriptionModule}  from './subscription/subscription.module';
import {DepartmentModule}    from './department/department.module';
import {ObservabilityModule} from './observability/observability.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load:     [configuration],
      envFilePath: ['.env'],
    }),

    // Rate limiting — 10-minute window on staging so testers don't get locked out.
    // Route-level @Throttle decorators narrow the limit for /register, /login, /users/lookup.
    ThrottlerModule.forRoot([{
      name:  'default',
      ttl:   600_000,     // 10 minute window in ms (NestJS v6 throttler uses ms)
      limit: 100,         // default ceiling; per-route overrides via @Throttle
    }]),

    DatabaseModule,
    RedisModule,
    KafkaModule,

    AuthModule,
    KeysModule,
    SenderCertModule,
    TotpModule,
    BiometricModule,
    UsersModule,
    ConversationsModule,
    BookingModule,
    WalletModule,
    TelemetryModule,
    AgentModule,
    OrgModule,
    AttendanceModule,
    OpsModule,
    OpsDeptChatModule,
    DispatchModule,
    ComplianceModule,
    SosModule,
    EventsModule,
    NotificationsModule,
    VbgModule,
    FamilyModule,
    SubscriptionModule,
    DepartmentModule,
    // Audit fix 5.4 — Sentry shim + audit-failure alert hook. @Global,
    // so OpsAuditService picks it up via optional DI without circular
    // module imports.
    ObservabilityModule,
  ],
})
export class AppModule {}
